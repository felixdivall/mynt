; Bodies indent between their braces: entry points, functions, if/else,
; loops, and add-line blocks all use `block`.
(block "{" @start "}" @end) @indent

; Argument and parameter lists that span lines indent their contents.
(arguments "(" @start ")" @end) @indent
(parameters "(" @start ")" @end) @indent

; A query or search whose `where` clause continues on following lines
; indents those lines one level past the statement that starts it.
(query_expression) @indent

; A projection's field list that spans lines indents its contents.
(projection_fields "[" @start "]" @end) @indent
