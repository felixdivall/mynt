/**
 * Tree-sitter grammar for Mynt.
 *
 * This grammar exists for editors: structure, fallback highlighting,
 * brackets, indentation, outline. The Mynt compiler's own recursive-descent
 * parser (src/parser/parser.ts in the mynt repository) is authoritative for
 * what the language accepts; this grammar follows it and may be more
 * tolerant of incomplete input, never stricter.
 *
 * Statement boundaries follow Mynt's newline rule: a newline ends a
 * statement where one may end (the external scanner emits a terminator only
 * when the grammar allows one there), except that a line beginning with
 * `where` continues a `query` or `search`. `query` and `search` themselves
 * are not tokens: each is the callee of a bare-type call, as in the
 * compiler. Keywords are contextual: a word is a keyword only where the
 * grammar expects one, so `let where = "x"` binds a local. Brackets exist
 * only for field projections, `ref[email, comments]`; Mynt has no indexing.
 */

const PREC = {
  where: 0,
  or: 1,
  and: 2,
  equality: 3,
  relational: 4,
  unary: 5,
  // A bare type argument (`create Customer`) reduces one level below a call
  // with arguments, so `load Customer("1")` shifts the `(` instead of nesting.
  bareTypeCall: 6,
  postfix: 7,
};

module.exports = grammar({
  name: "mynt",

  word: ($) => $.identifier,

  extras: ($) => [/[ \t\r\n]/, $.comment],

  externals: ($) => [$._newline_terminator],

  rules: {
    source_file: ($) => repeat(choice($._declaration, $._terminator)),

    _declaration: ($) => choice($.user_event, $.scheduled, $.function_declaration),

    // ---- declarations -------------------------------------------------------

    user_event: ($) =>
      seq(field("hook", $.hook), optional(field("events", $.event_filter)), "(", field("parameter", $.parameter), ")", field("body", $.block)),

    hook: ($) => choice("beforeSubmit", "afterSubmit"),

    event_filter: ($) => seq(field("event", $.identifier), repeat(seq("|", field("event", $.identifier)))),

    scheduled: ($) => seq("scheduled", field("body", $.block)),

    function_declaration: ($) =>
      seq(
        "fn",
        field("name", $.identifier),
        field("parameters", $.parameters),
        optional(seq(":", field("return_type", $._type))),
        field("body", $.block),
      ),

    parameters: ($) => seq("(", optional(seq($.parameter, repeat(seq(",", $.parameter)))), ")"),

    parameter: ($) => seq(field("name", $.identifier), ":", field("type", $._type)),

    _type: ($) => choice($.primitive_type, alias($.identifier, $.type_identifier)),
    // The language's builtin types, lowercase so they read differently from
    // the PascalCase record types the schema defines. Keyword extraction keeps
    // them identifiers everywhere else, e.g. as a field name after `.`.
    primitive_type: (_) => choice("string", "number", "boolean"),

    // ---- statements -----------------------------------------------------------

    block: ($) => seq("{", repeat($._statement), "}"),

    _statement: ($) =>
      seq(
        choice(
          $.let_statement,
          $.save_statement,
          $.delete_statement,
          $.remove_statement,
          $.add_statement,
          $.return_statement,
          $.if_statement,
          $.for_statement,
          $.assignment,
          $.expression_statement,
        ),
        optional($._terminator),
      ),

    _terminator: ($) => choice($._newline_terminator, ";"),

    let_statement: ($) => seq("let", field("name", $.identifier), "=", field("value", $._expression)),

    save_statement: ($) => seq("save", field("target", $._expression)),

    delete_statement: ($) => seq("delete", field("target", $._expression)),

    remove_statement: ($) => seq("remove", field("target", $._expression)),

    add_statement: ($) => seq("add", field("sublist", $._expression), field("body", $.block)),

    return_statement: ($) => prec.right(seq("return", optional(field("value", $._expression)))),

    if_statement: ($) =>
      seq("if", field("condition", $._expression), field("consequence", $.block), optional(seq("else", field("alternative", $.block)))),

    for_statement: ($) =>
      seq("for", field("variable", $.identifier), "in", field("iterable", $._expression), field("body", $.block)),

    assignment: ($) => seq(field("left", $._expression), "=", field("right", $._expression)),

    expression_statement: ($) => $._expression,

    // ---- expressions ----------------------------------------------------------

    _expression: ($) =>
      choice(
        $.identifier,
        $.string,
        $.number,
        $.boolean,
        $.member_expression,
        $.call_expression,
        $.projection_expression,
        $.query_expression,
        $.binary_expression,
        $.unary_expression,
        $.parenthesized_expression,
      ),

    member_expression: ($) => prec.left(PREC.postfix, seq(field("object", $._expression), ".", field("property", $.identifier))),

    /**
     * `load Customer("1")`, `create Customer`, `log.debug("x")`,
     * `transform SalesOrder("1") to Invoice`. A record type written after
     * the callee is a type argument; it may stand alone, as the compiler
     * allows for `create`.
     */
    call_expression: ($) =>
      choice(
        prec.left(
          PREC.postfix,
          seq(
            field("function", $._expression),
            optional(field("type", $._type)),
            field("arguments", $.arguments),
            optional(seq("to", field("target", $._type))),
          ),
        ),
        prec.left(PREC.bareTypeCall, seq(field("function", $._expression), field("type", $._type), optional(seq("to", field("target", $._type))))),
      ),

    arguments: ($) => seq("(", optional(seq($._expression, repeat(seq(",", $._expression)))), ")"),

    /**
     * `Customer(123)[email]`, `customer[email, comments]`: a projection of
     * schema fields from a record reference, a record, or a row. The
     * fields are bare names, never expressions, so this is not indexing.
     * `receiver` and `fields` are named so editor queries can tell the
     * projected names from the receiver.
     */
    projection_expression: ($) => prec.left(PREC.postfix, seq(field("receiver", $._expression), field("fields", $.projection_fields))),

    projection_fields: ($) => seq("[", optional(seq(field("field", $.identifier), repeat(seq(",", field("field", $.identifier))))), "]"),

    /**
     * `query Customer where ...` / `search Customer where ...`. The compiler
     * reads `query` and `search` as keywords only when a record type follows,
     * which is the bare-type-call shape above, so `search Customer` is a
     * call_expression here and `search` stays an ordinary identifier
     * elsewhere (`let search = 1`). Only the `where` clause needs its own node.
     */
    query_expression: ($) => prec.right(PREC.where, seq(field("query", $.call_expression), "where", field("condition", $._expression))),

    binary_expression: ($) =>
      choice(
        ...[
          ["||", PREC.or],
          ["&&", PREC.and],
          ["==", PREC.equality],
          ["!=", PREC.equality],
          ["<", PREC.relational],
          ["<=", PREC.relational],
          [">", PREC.relational],
          [">=", PREC.relational],
        ].map(([operator, precedence]) =>
          prec.left(precedence, seq(field("left", $._expression), field("operator", operator), field("right", $._expression))),
        ),
      ),

    unary_expression: ($) => prec(PREC.unary, seq(field("operator", "!"), field("operand", $._expression))),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),

    // ---- lexical --------------------------------------------------------------

    identifier: ($) => /[A-Za-z_][A-Za-z0-9_]*/,

    string: ($) => seq('"', repeat(choice(token.immediate(/[^"\\\n]+/), $.escape_sequence)), '"'),

    escape_sequence: ($) => token.immediate(/\\./),

    number: ($) => /[0-9]+(\.[0-9]+)?/,

    boolean: ($) => choice("true", "false"),

    comment: ($) => token(seq("//", /.*/)),
  },
});
