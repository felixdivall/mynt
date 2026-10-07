/**
 * An error whose message is meant for the person running the CLI. The CLI
 * prints `message` as is and `details` only under --verbose. Anything else
 * that escapes is a bug and is printed with its stack.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}
