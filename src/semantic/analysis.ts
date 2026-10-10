/**
 * Record lifecycle analysis: the flow-sensitive half of Mynt's record model.
 *
 * The binder decides what a value *is* (its record type and whether the
 * script owns it). This pass decides what has *happened* to an owned record
 * on each path through the entry point, and reports:
 *
 *   warning  a change (field write, line added or removed) that no later save persists;
 *   warning  a new record (create, copy, transform) that is never saved;
 *   error    delete of a new record before any save;
 *   error    delete of a record already deleted;
 *   error    any use of a record after it has been deleted;
 *   error    removal of a sublist line already removed, or any use of it after.
 *
 * It is a forward analysis over structured statements. The state on a path:
 *
 *   pending      changes to owned records not yet followed by a save
 *   unpersisted  new-record declarations not yet followed by a save
 *   saved        locals saved earlier on the path (wording only)
 *   mayDeleted   locals deleted on some path reaching here
 *   deleted      locals deleted on every path reaching here
 *   mayRemoved   line locals removed on some path reaching here
 *   removed      line locals removed on every path reaching here
 *
 * A line's removal state is reset at the start of each loop iteration,
 * since every iteration is a different line; the symbol is the same.
 *
 * A statement first has its uses checked against `mayDeleted` (a deleted
 * value is consumed: nothing may read, write, save, or delete it), then
 * applies its effect. An `if` runs both branches from a copy of the state
 * (a missing else is an empty branch) and joins: union for everything that
 * means "may have happened", intersection for `deleted`, which means "has
 * certainly happened". Union is the conservative direction for warnings and
 * for use-after-delete; intersection only sharpens the wording from "may
 * have been" to "has been".
 *
 * A function body is analyzed once, with each record parameter assumed to
 * be a persisted, clean record, and its exit state is projected onto the
 * parameters as a FunctionSummary. A call applies the callee's summary to
 * each record argument in the caller's state, and checks the argument's
 * origin against what the callee does: a context record cannot be passed
 * to a function that saves or deletes it, nor in afterSubmit to one that
 * modifies it. Summaries are computed in call order; recursion is refused.
 * A `return` ends its path; the exit of a body is the join of every
 * return with the fall-through.
 *
 * A `for` loop runs zero or more times. Its head state is the fixpoint of
 * joining the entry state with the body's exit state, computed by
 * re-running the body until nothing changes; diagnostics are suppressed
 * during that iteration and reported on one final pass from the stable
 * head. The state after the loop is the head state, since every exit
 * passes through it. The lattice is finite and the joins are monotone, so
 * the iteration terminates.
 *
 * Nothing here is a type: the same local is alive before `delete` and
 * consumed after it.
 */
import { DiagnosticBag, DiagnosticCode } from "../diagnostics.js";
import type {
  AddLine,
  BoundFunction,
  BoundStatement,
  DeleteRecord,
  FieldWrite,
  FunctionCall,
  LineBinding,
  LocalDeclaration,
  LocalReference,
  LocalSymbol,
  RemoveLine,
  ScriptUnit,
} from "./bound.js";
import { isLineType, isRecordType, sublistName } from "./types.js";
import { directExpressions, forEachExpression } from "./walk.js";

/** A call's effect on one record argument, as the callee's summary describes it. */
interface CallMutation {
  kind: "CallMutation";
  call: FunctionCall;
  owner: LocalSymbol;
  span: FieldWrite["span"];
}

/** A change to a record that must be saved to persist: a field write, a line added or removed, or a call that modifies it. */
type Mutation = FieldWrite | AddLine | RemoveLine | CallMutation;

/** What a function does to one record parameter, read off its body's exit state. */
export interface ParameterSummary {
  /** Written, or a line added or removed, somewhere in the body. */
  mutates: boolean;
  /** A change may still be unsaved when the function returns. */
  pendingAtExit: boolean;
  savesOnSomePath: boolean;
  savesOnAllPaths: boolean;
  deletesOnSomePath: boolean;
  deletesOnAllPaths: boolean;
}

export type FunctionSummary = ReadonlyMap<LocalSymbol, ParameterSummary>;

type Hook = "beforeSubmit" | "afterSubmit" | "execute" | "function";

export function checkRecordLifecycle(unit: ScriptUnit, diagnostics: DiagnosticBag): void {
  const summaries = new Map<BoundFunction, FunctionSummary>();
  const inProgress = new Set<BoundFunction>();
  const summaryOf = (fn: BoundFunction, report: (message: string) => void): FunctionSummary => {
    const known = summaries.get(fn);
    if (known) return known;
    if (inProgress.has(fn)) {
      report(`Recursive calls are not supported: '${fn.name}' is called while its own body is being analyzed`);
      return new Map();
    }
    inProgress.add(fn);
    const summary = new LifecycleAnalysis(diagnostics, unit.lineBindings, "function", summaryOf, fn).summarize();
    inProgress.delete(fn);
    summaries.set(fn, summary);
    return summary;
  };
  for (const fn of unit.functions) summaryOf(fn, () => {});
  if (unit.kind === "UserEvent") {
    for (const entryPoint of unit.entryPoints) new LifecycleAnalysis(diagnostics, unit.lineBindings, entryPoint.hook, summaryOf).run(entryPoint.body);
  } else {
    new LifecycleAnalysis(diagnostics, unit.lineBindings, "execute", summaryOf).run(unit.entryPoint.body);
  }
}

interface PathState {
  pending: Set<Mutation>;
  unpersisted: Set<LocalDeclaration>;
  saved: Set<LocalSymbol>;
  /** Saved on every path reaching here. */
  savedAll: Set<LocalSymbol>;
  mayDeleted: Set<LocalSymbol>;
  deleted: Set<LocalSymbol>;
  mayRemoved: Set<LocalSymbol>;
  removed: Set<LocalSymbol>;
  /** True after a `return`: no path continues from here. */
  dead: boolean;
}

/** One mention of a local inside a statement, with what the statement does with it. */
interface LocalUse {
  reference: LocalReference;
  use: "read" | "write" | "save" | "delete" | "remove" | "sublist" | "other";
  /** The field, or for a sublist use a stand-in carrying the sublist id. */
  field?: { id: string };
}

class LifecycleAnalysis {
  /** Writes that some path did save after. Decides between "never" and "not every path". */
  private readonly savedOnSomePath = new Set<Mutation>();
  /** New records that some path did save. Same distinction, for declarations. */
  private readonly persistedOnSomePath = new Set<LocalDeclaration>();
  /** Every new-record declaration seen, by its local: a save inside `try` leaves the record not certainly saved afterwards. */
  private readonly newRecords = new Map<LocalSymbol, LocalDeclaration>();
  /** Writes that followed a save of their record on their own path. */
  private readonly savedBefore = new Set<Mutation>();

  /** Greater than zero while a loop body is being iterated to its fixpoint. */
  private silenced = 0;
  /** One per enclosing `try` body being flowed: the join of the states after every statement so far, which is where its handler may start. */
  private readonly handlerEntries: { state: PathState }[] = [];

  /** The record local a reference's persistence belongs to: itself, or a line's parent. */
  private owner(local: LocalSymbol): LocalSymbol {
    return this.lineBindings.get(local)?.parent ?? local;
  }

  /** The record local a mutation changes. */
  private mutationOwner(mutation: Mutation): LocalSymbol {
    switch (mutation.kind) {
      case "FieldWrite":
        return this.owner(mutation.receiver.local);
      case "AddLine":
        return mutation.parent;
      case "RemoveLine":
        return mutation.binding.parent;
      case "CallMutation":
        return mutation.owner;
    }
  }

  /** Whether a record local's changes are tracked: owned records, and parameters inside a function body. */
  private tracked(owner: LocalSymbol): boolean {
    return isRecordType(owner.type) && (owner.type.origin === "owned" || owner.type.origin === "parameter");
  }

  /** Every record local that any mutation touched, on any path. */
  private readonly mutated = new Set<LocalSymbol>();
  /** States at each `return`, joined with the fall-through at the end. */
  private exits: PathState[] = [];
  /** Call effects, one object per call and argument, stable across fixpoint passes. */
  private readonly callMutations = new Map<FunctionCall, Map<LocalSymbol, CallMutation>>();

  constructor(
    private readonly diagnostics: DiagnosticBag,
    private readonly lineBindings: ReadonlyMap<LocalSymbol, LineBinding>,
    private readonly hook: Hook,
    private readonly summaryOf: (fn: BoundFunction, report: (message: string) => void) => FunctionSummary,
    /** Set when analyzing a function body: its parameters are summarized, not reported. */
    private readonly fn?: BoundFunction,
  ) {}

  private isParameter(local: LocalSymbol): boolean {
    return this.fn?.parameters.includes(local) ?? false;
  }

  /** Analyzes a function body and projects its exit state onto the record parameters. */
  summarize(): FunctionSummary {
    const exit = this.runBody(this.fn!.body);
    const summary = new Map<LocalSymbol, ParameterSummary>();
    for (const parameter of this.fn!.parameters) {
      if (!isRecordType(parameter.type)) continue;
      summary.set(parameter, {
        mutates: this.mutated.has(parameter),
        pendingAtExit: [...exit.pending].some((m) => this.mutationOwner(m) === parameter),
        savesOnSomePath: exit.saved.has(parameter),
        savesOnAllPaths: exit.savedAll.has(parameter),
        deletesOnSomePath: exit.mayDeleted.has(parameter),
        deletesOnAllPaths: exit.deleted.has(parameter),
      });
    }
    return summary;
  }

  private error(code: DiagnosticCode, message: string, span: FieldWrite["span"]): void {
    if (this.silenced === 0) this.diagnostics.error(code, message, span);
  }

  run(body: readonly BoundStatement[]): void {
    const exit = this.runBody(body);
    const unpersistedLocals = new Set([...exit.unpersisted].map((d) => d.local));
    for (const declaration of [...exit.unpersisted].sort(bySource)) this.reportUnpersisted(declaration);
    const unsaved = [...exit.pending]
      .filter((m) => !unpersistedLocals.has(this.mutationOwner(m)) && !this.isParameter(this.mutationOwner(m)))
      .sort(bySource);
    for (const mutation of unsaved) this.reportUnsavedMutation(mutation);
  }

  /** Flows a whole body and joins every `return` with the fall-through. */
  private runBody(body: readonly BoundStatement[]): PathState {
    this.exits = [];
    let exit = this.flow(body, emptyState());
    for (const returned of this.exits) exit = join(exit, returned);
    // Pending changes to parameters are the caller's business: report the rest.
    if (this.fn) {
      const unsaved = [...exit.pending].filter((m) => !this.isParameter(this.mutationOwner(m))).sort(bySource);
      const unpersistedLocals = new Set([...exit.unpersisted].map((d) => d.local));
      for (const declaration of [...exit.unpersisted].sort(bySource)) this.reportUnpersisted(declaration);
      for (const mutation of unsaved.filter((m) => !unpersistedLocals.has(this.mutationOwner(m)))) this.reportUnsavedMutation(mutation);
    }
    return exit;
  }

  /** Transfer function for a statement list. Mutates and returns `state`. */
  private flow(body: readonly BoundStatement[], state: PathState): PathState {
    for (const statement of body) {
      if (state.dead) break;
      this.step(statement, state, (next) => (state = next));
      for (const entry of this.handlerEntries) entry.state = join(entry.state, state);
    }
    return state;
  }

  /** One statement of `flow`; `replace` installs a successor state built from the current one. */
  private step(statement: BoundStatement, state: PathState, replace: (next: PathState) => void): void {
    {
      for (const use of localUsesIn(statement)) {
        const { local } = use.reference;
        if (state.mayRemoved.has(local)) {
          this.reportUseAfterRemove(use, state.removed.has(local));
          continue;
        }
        const owner = this.owner(local);
        if (state.mayDeleted.has(owner)) this.reportUseAfterDelete(use, owner, state.deleted.has(owner));
      }
      for (const root of directExpressions(statement)) {
        forEachExpression(root, (expression) => {
          if (expression.kind === "FunctionCall") this.applyCall(expression, state);
        });
      }
      switch (statement.kind) {
        case "LocalDeclaration": {
          const { initializer } = statement;
          if (initializer.kind === "BuiltinCall" && initializer.builtin.kind === "recordOperation" && initializer.builtin.result === "new") {
            state.unpersisted.add(statement);
            this.newRecords.set(statement.local, statement);
          }
          // `or { ... }`: the absence branch runs on one path and leaves (every path returns), the binding on the other.
          if (initializer.kind === "OptionalResolve") replace(join(this.flow(initializer.absence, clone(state)), state));
          break;
        }
        case "TryCatch": {
          // Any statement of the body may throw, so the handler starts from the join of the state before the body
          // and the state after each of its statements (nested bodies included): "may" facts from every prefix
          // survive, "certainly" facts only if every prefix has them. The finalizer runs after either outcome, and
          // what follows sees their join.
          const entry = { state: clone(state) };
          this.handlerEntries.push(entry);
          const tried = this.flow(statement.body, clone(state));
          this.handlerEntries.pop();
          // Changes the exception interrupted are not the handler's to redo: a pending write or an unsaved new
          // record is dropped at the handler's start, so `try { r.x = 1; save r } catch err { log.error(err) }`
          // does not warn. The normal path (`tried`) still carries whatever the body left pending.
          entry.state.pending.clear();
          entry.state.unpersisted.clear();
          const after = statement.handler ? join(tried, this.flow(statement.handler, entry.state)) : tried;
          replace(statement.finalizer ? this.flow(statement.finalizer, after) : after);
          break;
        }
        case "FieldWrite":
        case "AddLine":
        case "RemoveLine": {
          if (statement.kind === "RemoveLine") this.applyRemove(statement, state);
          this.applyMutation(statement, state);
          break;
        }
        case "Return":
          this.exits.push(clone(state));
          replace(deadState());
          break;
        case "SaveRecord": {
          if (statement.target.kind !== "LocalReference") break;
          const { local } = statement.target;
          for (const mutation of state.pending) {
            if (this.mutationOwner(mutation) === local) {
              state.pending.delete(mutation);
              this.savedOnSomePath.add(mutation);
            }
          }
          for (const declaration of state.unpersisted) {
            if (declaration.local === local) {
              state.unpersisted.delete(declaration);
              this.persistedOnSomePath.add(declaration);
            }
          }
          state.saved.add(local);
          state.savedAll.add(local);
          break;
        }
        case "DeleteRecord":
          this.applyDelete(statement, state);
          break;
        case "If": {
          const thenState = this.flow(statement.thenBody, clone(state));
          const elseState = statement.elseBody ? this.flow(statement.elseBody, clone(state)) : state;
          replace(join(thenState, elseState));
          break;
        }
        case "ForEach":
          replace(this.flowLoop(statement.body, state, statement.local));
          break;
        case "ExpressionStatement":
          break;
      }
    }
  }

  /** Fixpoint of the loop head: entry joined with the body's exit, until stable. */
  private flowLoop(body: readonly BoundStatement[], entry: PathState, variable: LocalSymbol): PathState {
    // Each iteration binds a fresh line: its removal state does not carry over.
    const fresh = (state: PathState): PathState => {
      const next = clone(state);
      next.mayRemoved.delete(variable);
      next.removed.delete(variable);
      return next;
    };
    let head = clone(entry);
    this.silenced++;
    try {
      for (;;) {
        const exit = this.flow(body, fresh(head));
        const next = join(head, exit);
        if (sameState(next, head)) break;
        head = next;
      }
    } finally {
      this.silenced--;
    }
    // One reporting pass from the stable head. Its exit is already within the head.
    this.flow(body, fresh(head));
    return fresh(head);
  }

  private applyMutation(mutation: Mutation, state: PathState): void {
    const owner = this.mutationOwner(mutation);
    this.mutated.add(owner);
    if (!this.tracked(owner) || state.mayDeleted.has(owner)) return;
    state.pending.add(mutation);
    if (state.saved.has(owner)) this.savedBefore.add(mutation);
  }

  /**
   * A call: check each record argument's origin against the callee's
   * summary, then apply the summary to the argument's state as if the
   * callee's statements had run here.
   */
  private applyCall(call: FunctionCall, state: PathState): void {
    const summary = this.summaryOf(call.function, (message) => this.error(DiagnosticCode.RecursionNotSupported, message, call.callee.span));
    call.function.parameters.forEach((parameter, index) => {
      const effect = summary.get(parameter);
      const argument = call.arguments[index];
      if (!effect || !argument || argument.kind !== "LocalReference" || !isRecordType(argument.type)) return;
      const local = argument.local;
      const name = call.function.name;
      const record = argument.type.record.name;

      if (argument.type.origin === "context") {
        if (effect.deletesOnSomePath || effect.savesOnSomePath) {
          const does = effect.deletesOnSomePath ? "deletes" : "saves";
          this.error(
            DiagnosticCode.ArgumentOrigin,
            `'${local.name}' is the ${record} from ${this.hook} and cannot be passed to '${name}', which ${does} it: NetSuite owns its persistence`,
            argument.span,
          );
          return;
        }
        if (effect.mutates && this.hook === "afterSubmit") {
          this.error(
            DiagnosticCode.ArgumentOrigin,
            `'${local.name}' cannot be passed to '${name}' in afterSubmit: the function modifies it, and the ${record} is already saved, so the change would be silently discarded`,
            argument.span,
          );
          return;
        }
        return;
      }

      if (effect.deletesOnSomePath) {
        const unsaved = this.unsavedNew(local, state);
        if (unsaved) {
          this.error(
            DiagnosticCode.DeleteBeforeSave,
            `Cannot pass '${local.name}' to '${name}', which deletes it, before it has been saved: a new ${record} does not exist in NetSuite until you 'save ${local.name}'`,
            argument.span,
          );
          return;
        }
      }

      if (effect.savesOnAllPaths) {
        for (const mutation of state.pending) {
          if (this.mutationOwner(mutation) === local) {
            state.pending.delete(mutation);
            this.savedOnSomePath.add(mutation);
          }
        }
        for (const declaration of state.unpersisted) {
          if (declaration.local === local) {
            state.unpersisted.delete(declaration);
            this.persistedOnSomePath.add(declaration);
          }
        }
        state.saved.add(local);
        state.savedAll.add(local);
      } else if (effect.savesOnSomePath) {
        for (const mutation of state.pending) if (this.mutationOwner(mutation) === local) this.savedOnSomePath.add(mutation);
        for (const declaration of state.unpersisted) if (declaration.local === local) this.persistedOnSomePath.add(declaration);
        state.saved.add(local);
      }

      if (effect.pendingAtExit) {
        let perCall = this.callMutations.get(call);
        if (!perCall) this.callMutations.set(call, (perCall = new Map()));
        let mutation = perCall.get(local);
        if (!mutation) perCall.set(local, (mutation = { kind: "CallMutation", call, owner: local, span: call.span }));
        this.applyMutation(mutation, state);
        // The callee saves on some path but not all: whether its own save
        // came before or after the change is not known, so say "not every path".
        if (effect.savesOnSomePath && !effect.savesOnAllPaths) {
          this.savedOnSomePath.add(mutation);
          this.savedBefore.delete(mutation);
        }
      } else if (effect.mutates) {
        this.mutated.add(local);
      }

      if (effect.deletesOnSomePath) {
        state.mayDeleted.add(local);
        if (effect.deletesOnAllPaths) state.deleted.add(local);
        for (const mutation of state.pending) if (this.mutationOwner(mutation) === local) state.pending.delete(mutation);
      }
    });
  }

  private applyRemove(statement: RemoveLine, state: PathState): void {
    const { local } = statement.line;
    // A double remove was already reported as a use of a removed line.
    state.mayRemoved.add(local);
    state.removed.add(local);
  }

  private reportUseAfterRemove(use: LocalUse, certain: boolean): void {
    const { local } = use.reference;
    const owner = isLineType(local.type) ? sublistName(local.type) : "sublist";
    const when = certain ? "has been removed" : "may already have been removed on this path";
    let code: DiagnosticCode = DiagnosticCode.UseAfterRemove;
    let message: string;
    switch (use.use) {
      case "read":
        message = `Cannot read field '${use.field!.id}': this ${owner} line ${when}`;
        break;
      case "write":
        message = `Cannot assign ${owner}.${use.field!.id}: this ${owner} line ${when}`;
        break;
      case "remove":
        code = DiagnosticCode.DoubleRemove;
        message = `This ${owner} line ${certain ? "has already been removed" : "may already have been removed on this path"}`;
        break;
      default:
        message = `'${local.name}' cannot be used: this ${owner} line ${when}`;
        break;
    }
    this.error(code, message, use.reference.span);
  }

  private applyDelete(statement: DeleteRecord, state: PathState): void {
    const { local } = statement.target;
    // A double delete was already reported as a use of a deleted value; after it, the record is certainly gone.
    if (state.mayDeleted.has(local)) {
      state.deleted.add(local);
      return;
    }

    const unsaved = this.unsavedNew(local, state);
    if (unsaved) {
      const record = isRecordType(local.type) ? local.type.record.name : "record";
      const message = this.persistedOnSomePath.has(unsaved) || !state.unpersisted.has(unsaved)
        ? `Cannot delete '${local.name}': it may not have been saved on every path that reaches this delete`
        : `Cannot delete '${local.name}' before it has been saved: a new ${record} does not exist in NetSuite until you 'save ${local.name}'`;
      this.error(DiagnosticCode.DeleteBeforeSave, message, statement.span);
      // Treat the delete as a no-op, so the error does not cascade.
      state.unpersisted.delete(unsaved);
      return;
    }

    state.mayDeleted.add(local);
    state.deleted.add(local);
    // Whatever was changed on it no longer matters.
    for (const mutation of state.pending) if (this.mutationOwner(mutation) === local) state.pending.delete(mutation);
  }

  private reportUseAfterDelete(use: LocalUse, owner: LocalSymbol, certain: boolean): void {
    const name = owner.name;
    const when = certain ? "has been deleted" : "may already have been deleted on this path";
    const type = use.reference.local.type;
    const record = isRecordType(type) ? type.record.name : isLineType(type) ? sublistName(type) : "record";
    let message: string;
    let code: DiagnosticCode = DiagnosticCode.UseAfterDelete;
    switch (use.use) {
      case "read":
        message = `Cannot read field '${use.field!.id}' because '${name}' ${when}`;
        break;
      case "write":
        message = `Cannot assign ${record}.${use.field!.id} because '${name}' ${when}`;
        break;
      case "sublist":
        message = `Cannot access sublist '${use.field!.id}' because '${name}' ${when}`;
        break;
      case "remove":
        message = `Cannot remove a line because '${name}' ${when}`;
        break;
      case "save":
        message = certain ? `Cannot save '${name}' after it has been deleted` : `Cannot save '${name}': it ${when}`;
        break;
      case "delete":
        code = DiagnosticCode.DoubleDelete;
        message = certain ? `'${name}' has already been deleted` : `'${name}' ${when}`;
        break;
      case "other":
        message = `'${name}' ${when} and cannot be used`;
        break;
    }
    this.error(code, message, use.reference.span);
  }

  /**
   * The declaration of `local` if it is a new record not certainly saved here: still pending on some path, or
   * saved only on some paths (a save inside `try` counts for the normal path alone, since its handler may have
   * run instead). The second case blocks a delete without being an "unsaved" warning of its own.
   */
  private unsavedNew(local: LocalSymbol, state: PathState): LocalDeclaration | undefined {
    const declaration = this.newRecords.get(local);
    if (!declaration) return undefined;
    return state.unpersisted.has(declaration) || !state.savedAll.has(local) ? declaration : undefined;
  }

  private reportUnpersisted(declaration: LocalDeclaration): void {
    const { local } = declaration;
    const record = isRecordType(local.type) ? local.type.record.name : "record";
    const message = this.persistedOnSomePath.has(declaration)
      ? `'${local.name}' may leave this script unsaved: it is created here, but not every execution path that follows performs 'save ${local.name}'`
      : `'${local.name}' is created but never saved; a new ${record} does not exist in NetSuite until you 'save ${local.name}'`;
    if (this.silenced === 0) this.diagnostics.warning(DiagnosticCode.UnsavedMutation, message, declaration.span);
  }

  private reportUnsavedMutation(write: Mutation): void {
    const local = this.mutationOwner(write);
    const record = isRecordType(local.type) ? local.type.record.name : "record";
    const modified = write.kind === "CallMutation" ? `modified by '${write.call.function.name}'` : "modified";
    let message: string;
    if (this.savedOnSomePath.has(write)) {
      message =
        `'${local.name}' may leave this script with unsaved changes: it is ${modified} here, ` +
        `but not every execution path that follows performs 'save ${local.name}'`;
    } else if (this.savedBefore.has(write)) {
      message =
        `'${local.name}' is ${modified} after its last save; this change to the loaded ${record} ` +
        `is discarded unless you 'save ${local.name}' again`;
    } else {
      message =
        `'${local.name}' is ${modified} but never saved; changes to a loaded ${record} are discarded ` +
        `unless you 'save ${local.name}'`;
    }
    if (this.silenced === 0) this.diagnostics.warning(DiagnosticCode.UnsavedMutation, message, write.span);
  }
}

/**
 * The locals a statement mentions, excluding nested bodies (which flow
 * visits themselves), each with what the statement does with it. A local
 * that is the receiver of a field access, sublist access, save, delete, or
 * remove is reported with that use; any other mention is "other".
 */
function localUsesIn(statement: BoundStatement): LocalUse[] {
  const uses: LocalUse[] = [];
  const claimed = new Set<LocalReference>();
  const claim = (reference: LocalReference, use: LocalUse["use"], field?: { id: string }): void => {
    claimed.add(reference);
    uses.push(field ? { reference, use, field } : { reference, use });
  };
  switch (statement.kind) {
    case "FieldWrite":
      claim(statement.receiver, "write", statement.field);
      break;
    case "SaveRecord":
      if (statement.target.kind === "LocalReference") claim(statement.target, "save");
      break;
    case "DeleteRecord":
      claim(statement.target, "delete");
      break;
    case "RemoveLine":
      claim(statement.line, "remove");
      break;
    default:
      break;
  }
  // Record arguments are uses of the record: a deleted one cannot be passed.
  for (const root of directExpressions(statement)) {
    forEachExpression(root, (expression) => {
      if (expression.kind !== "FunctionCall") return;
      for (const argument of expression.arguments) if (argument.kind === "LocalReference" && !claimed.has(argument)) claim(argument, "other");
    });
  }
  for (const root of directExpressions(statement)) {
    forEachExpression(root, (expression) => {
      if (expression.kind === "FieldRead" && expression.receiver.kind === "LocalReference") {
        claim(expression.receiver, "read", expression.field);
      } else if (expression.kind === "ResultFieldRead" && expression.receiver.kind === "LocalReference") {
        claim(expression.receiver, "read", { id: expression.result.name });
      } else if (expression.kind === "Lookup" && expression.receiver.kind === "LocalReference") {
        // A projection reads every listed field at once.
        claim(expression.receiver, "read", { id: expression.fields.map((f) => f.field.id).join(", ") });
      } else if (expression.kind === "SublistAccess" && expression.receiver.kind === "LocalReference") {
        claim(expression.receiver, "sublist", { id: expression.sublist.id });
      } else if (expression.kind === "LocalReference" && !claimed.has(expression)) {
        claim(expression, "other");
      }
    });
  }
  return uses;
}

function emptyState(): PathState {
  return {
    pending: new Set(),
    unpersisted: new Set(),
    saved: new Set(),
    savedAll: new Set(),
    mayDeleted: new Set(),
    deleted: new Set(),
    mayRemoved: new Set(),
    removed: new Set(),
    dead: false,
  };
}

function deadState(): PathState {
  return { ...emptyState(), dead: true };
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function sameState(a: PathState, b: PathState): boolean {
  return (
    a.dead === b.dead &&
    sameSet(a.savedAll, b.savedAll) &&
    sameSet(a.pending, b.pending) &&
    sameSet(a.unpersisted, b.unpersisted) &&
    sameSet(a.saved, b.saved) &&
    sameSet(a.mayDeleted, b.mayDeleted) &&
    sameSet(a.deleted, b.deleted) &&
    sameSet(a.mayRemoved, b.mayRemoved) &&
    sameSet(a.removed, b.removed)
  );
}

function bySource(a: { span: { start: { offset: number } } }, b: { span: { start: { offset: number } } }): number {
  return a.span.start.offset - b.span.start.offset;
}

function clone(state: PathState): PathState {
  return {
    pending: new Set(state.pending),
    unpersisted: new Set(state.unpersisted),
    saved: new Set(state.saved),
    savedAll: new Set(state.savedAll),
    mayDeleted: new Set(state.mayDeleted),
    deleted: new Set(state.deleted),
    mayRemoved: new Set(state.mayRemoved),
    removed: new Set(state.removed),
    dead: state.dead,
  };
}

/** Join at a control-flow merge: "may" sets by union, "certainly" sets by intersection; a dead path contributes nothing. */
function join(a: PathState, b: PathState): PathState {
  if (a.dead) return clone(b);
  if (b.dead) return clone(a);
  return {
    pending: new Set([...a.pending, ...b.pending]),
    unpersisted: new Set([...a.unpersisted, ...b.unpersisted]),
    saved: new Set([...a.saved, ...b.saved]),
    savedAll: new Set([...a.savedAll].filter((l) => b.savedAll.has(l))),
    mayDeleted: new Set([...a.mayDeleted, ...b.mayDeleted]),
    deleted: new Set([...a.deleted].filter((l) => b.deleted.has(l))),
    mayRemoved: new Set([...a.mayRemoved, ...b.mayRemoved]),
    removed: new Set([...a.removed].filter((l) => b.removed.has(l))),
    dead: false,
  };
}
