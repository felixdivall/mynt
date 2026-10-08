(function_declaration
  body: (block (_)* @function.inside)) @function.around

(user_event
  body: (block (_)* @function.inside)) @function.around

(scheduled
  body: (block (_)* @function.inside)) @function.around

(comment) @comment.around
