import { ActionError, PI_BUILTIN_COMMANDS, type Thread } from "@herdr-web/agents";
import type { CoreSession } from "@herdr-web/core-client";
import type {
  ChatDone,
  ChatEffortInput,
  ChatModelInput,
  ChatOlderInput,
  ChatPage,
  ChatResultInput,
  ChatSendInput,
  ChatSent,
  ChatStopInput,
  ChatToolResult,
} from "@herdr-web/protocol";
import type { ChatHub } from "./chat.js";
import { coreFailure, OperationFailure } from "./operations.js";

/**
 * What the browser may do to a chat: send, stop, change model or effort, ask for an older page or
 * a whole tool result. Each checks that the terminal is live, on this computer and has a chat
 * before anything is asked of the agent; a refusal is a sentence. The one write to core is typing
 * one of pi's own `/commands` into the terminal.
 */
export class ChatOperations {
  constructor(
    private readonly session: CoreSession,
    private readonly chat: ChatHub,
  ) {}

  /** The thread of a terminal, or the refusal. */
  private thread(terminal: string): Thread {
    const t = this.session.store.get(terminal);
    if (!t) throw new OperationFailure(404, `No terminal ${terminal}.`);
    if (t.state !== "live") throw new OperationFailure(409, `${terminal} has ended.`);
    const thread = this.chat.thread(terminal);
    if (!thread || thread.closed) throw new OperationFailure(409, this.chat.whyNot(terminal));
    return thread;
  }

  /** An agent action's failure is its own sentence; anything else is ours to hide. */
  private async act<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ActionError) throw new OperationFailure(409, error.message);
      if (error instanceof OperationFailure) throw error;
      throw new OperationFailure(500, "Something went wrong in the bridge.");
    }
  }

  async send(input: ChatSendInput): Promise<ChatSent> {
    const thread = this.thread(input.terminal);
    const command = input.text.startsWith("/") ? /^\/(\S*)\s*([\s\S]*)$/.exec(input.text) : null;
    const name = command?.[1] ?? "";
    const rest = (command?.[2] ?? "").trim();
    if (name === "compact") {
      await this.act(() => thread.compact(rest === "" ? undefined : rest));
      return { via: "agent" };
    }
    if (name === "name" && rest !== "") {
      await this.act(() => thread.setName(rest));
      return { via: "agent" };
    }
    if (command === null || !PI_BUILTIN_COMMANDS.includes(name)) {
      // A message, or a command that is not one of pi's own (a skill, a prompt template, an extension's): pi runs it as it runs anything sent.
      await this.act(() => thread.send(input.text));
      return { via: "agent" };
    }
    // One of pi's own screens (`/model`, `/tree`, ...): typed into the terminal as a person would, after the input box is emptied so
    // it is not appended to a draft.
    await this.act(() => thread.clearInput());
    try {
      await this.session.call("terminal.send", { terminal: input.terminal, text: input.text });
    } catch (error) {
      throw coreFailure(error);
    }
    return { via: "terminal" };
  }

  async stop(input: ChatStopInput): Promise<ChatDone> {
    const thread = this.thread(input.terminal);
    await this.act(() => thread.stop());
    return { ok: true };
  }

  async model(input: ChatModelInput): Promise<ChatDone> {
    const thread = this.thread(input.terminal);
    await this.act(() => thread.setModel(input.model));
    return { ok: true };
  }

  async effort(input: ChatEffortInput): Promise<ChatDone> {
    const thread = this.thread(input.terminal);
    await this.act(() => thread.setEffort(input.effort));
    return { ok: true };
  }

  async older(input: ChatOlderInput): Promise<ChatPage> {
    const thread = this.thread(input.terminal);
    return this.act(() => thread.page(input.before, input.limit));
  }

  async result(input: ChatResultInput): Promise<ChatToolResult> {
    const thread = this.thread(input.terminal);
    return { text: await this.act(() => thread.toolResult(input.row)) };
  }
}
