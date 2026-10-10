(function_declaration
  body: (block (_)* @function.inside)) @function.around

(user_event
  body: (block (_)* @function.inside)) @function.around

(scheduled
  body: (block (_)* @function.inside)) @function.around

(try_statement
  body: (block (_)* @function.inside))

(comment) @comment.around
