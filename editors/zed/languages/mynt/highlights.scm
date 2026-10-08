; Syntax-level highlighting only. The Mynt language server refines these
; with semantic tokens (types, parameters, variables, fields, built-ins,
; read-only state, modifications); nothing here guesses at the schema.

(comment) @comment

(string) @string
(escape_sequence) @string.escape
(number) @number
(boolean) @boolean

; Keywords, only where the grammar read them as keywords.
(hook) @keyword
[
  "scheduled"
  "fn"
  "let"
  "if"
  "else"
  "for"
  "in"
  "where"
  "save"
  "delete"
  "add"
  "remove"
  "to"
  "return"
] @keyword

; Event filters are members of a fixed set.
(event_filter (identifier) @constant)

; Syntactic type positions: parameter types, return types, record operations, queries.
(type_identifier) @type
(primitive_type) @type.builtin

; Members, and the fields a projection names: `ref[email, comments]`.
(member_expression property: (identifier) @property)
(projection_fields field: (identifier) @property)

; Declarations and calls.
(function_declaration name: (identifier) @function)
(parameter name: (identifier) @variable.parameter)
(let_statement name: (identifier) @variable)
(for_statement variable: (identifier) @variable)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (identifier) @function.method))

; The builtin operations are one family. Each is the callee of a bare-type
; call (`query Customer`, `search Customer`, `load Customer("1")`), captured
; as a builtin function so the fallback agrees with the semantic token the
; server sends (`function` + `defaultLibrary`); `where` and `to` stay keywords.
((call_expression function: (identifier) @function.builtin type: (type_identifier))
  (#match? @function.builtin "^(query|search|load|create|copy|transform)$"))

; `Customer(123)` is a record reference, not a call: the callee is a record
; type. The grammar cannot consult the schema, so the fallback uses Mynt's
; convention that record types are PascalCase and user functions are not;
; the server's semantic token (`struct`) is authoritative.
((call_expression function: (identifier) @type)
  (#match? @type "^[A-Z]"))

[
  "="
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "&&"
  "||"
  "!"
  "|"
] @operator

["(" ")" "{" "}" "[" "]"] @punctuation.bracket
["," ":" "."] @punctuation.delimiter
