; Entry points and functions only; locals and branches are not outline items.
(function_declaration
  "fn" @context
  name: (identifier) @name
  parameters: (parameters) @context.extra) @item

(user_event
  hook: (hook) @name
  events: (event_filter)? @context.extra) @item

(scheduled
  "scheduled" @name) @item
