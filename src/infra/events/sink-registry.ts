import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationSink, ConversationSinkConfig } from "./conversation-sink.js";

const log = createSubsystemLogger("sink-registry");

export class SinkRegistry {
  private sinks = new Map<string, ConversationSink>();
  private active = new Map<string, () => void>();

  register(sink: ConversationSink): void {
    this.sinks.set(sink.id, sink);
  }

  startAll(configs: ConversationSinkConfig[]): void {
    for (const config of configs) {
      if (!config.enabled) {
        log.debug("sink disabled, skipping", { id: config.id });
        continue;
      }
      const sink = this.sinks.get(config.id);
      if (!sink) {
        log.warn("no sink registered for config id", { id: config.id });
        continue;
      }
      try {
        const stop = sink.start(config);
        this.active.set(config.id, stop);
        log.info("sink started", { id: config.id });
      } catch (err) {
        log.warn("sink failed to start", { id: config.id, error: String(err) });
      }
    }
  }

  stopAll(): void {
    for (const [id, stop] of this.active) {
      try {
        stop();
      } catch (err) {
        log.warn("sink failed to stop", { id, error: String(err) });
      }
    }
    this.active.clear();
  }

  reload(configs: ConversationSinkConfig[]): void {
    this.stopAll();
    this.startAll(configs);
  }
}
