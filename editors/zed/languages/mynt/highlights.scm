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
  "select"
  "order"
  "group"
  "by"
  "asc"
  "desc"
  "limit"
  "or"
  "try"
  "catch"
  "finally"
  "save"
  "delete"
  "add"
  "remove"
  "to"
  "return"
] @keyword

; `first` is a clause of one word, so its node is the keyword.
(first_clause) @keyword

; Event filters are members of a fixed set.
(event_filter (identifier) @constant)

; Syntactic type positions: parameter types, return types, record operations, queries.
(type_identifier) @type
(primitive_type) @type.builtin

; Members, the fields a projection names (`ref[email, comments]`), and the fields a search clause names.
(member_expression property: (identifier) @property)
(projection_fields field: (identifier) @property)
(select_clause field: (identifier) @property)
(sort_key field: (identifier) @property)
(group_clause field: (identifier) @property)

; A summary's aggregates: the result name is a property the row exposes, the aggregate a builtin operation like `search`.
(aggregate_item alias: (identifier) @property)
(aggregate_function) @function.builtin

; Declarations and calls.
(function_declaration name: (identifier) @function)
(parameter name: (identifier) @variable.parameter)
(let_statement name: (identifier) @variable)
; A pattern binds locals; a source named apart from its local (`comments: note`) is the field, the local the variable.
(pattern_field source: (identifier) @variable)
(pattern_field source: (identifier) @property local: (identifier) @variable)
(try_statement binding: (identifier) @variable)
(for_statement variable: (identifier) @variable)
(call_expression function: (identifier) @function)
(call_expression function: (member_expression property: (identifier) @function.method))

; The builtin operations are one family. Each is the callee of a bare-type
; call (`query Customer`, `search Customer`, `load Customer("1")`), captured
; as a builtin function so the fallback agrees with the semantic token the
; server sends (`function` + `defaultLibrary`); `where` and `to` stay keywords.
((call_expression function: (identifier) @function.builtin type: (type_identifier))
  (#match? @function.builtin "^(query|search|load|create|copy|transform|lookup)$"))
; The loadable platform types read as builtin types, like `string`.
((call_expression type: (type_identifier) @type.builtin)
  (#match? @type.builtin "^(Search|File)$"))

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
  "==="
  "!=="
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
