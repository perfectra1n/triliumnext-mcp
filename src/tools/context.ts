/** Per-call hooks a tool handler may use; every field is optional. */
export interface ToolContext {
  /**
   * Report progress to the MCP client. A no-op unless the client sent a
   * progressToken with the tool call.
   */
  progress?: (message: string) => void;
}
