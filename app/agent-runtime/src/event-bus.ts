import { EventEmitter } from "node:events";
import type { RecordingSegment, RuntimeEvent, RuntimeOptions } from "./types.js";
import { DEFAULT_OPTIONS } from "./types.js";

const MAX_EVENTS = 200;
const MAX_RECORDINGS = 120;

export class ThreadEventBus {
  private readonly emitter = new EventEmitter();
  private readonly history = new Map<string, RuntimeEvent[]>();
  private readonly recordings = new Map<string, RecordingSegment[]>();
  private readonly options = new Map<string, RuntimeOptions>();

  emit(event: RuntimeEvent): void {
    const bucket = this.history.get(event.threadId) || [];
    bucket.push(event);
    if (bucket.length > MAX_EVENTS) {
      bucket.splice(0, bucket.length - MAX_EVENTS);
    }
    this.history.set(event.threadId, bucket);
    this.emitter.emit(this.key(event.threadId), event);
  }

  subscribe(threadId: string, listener: (event: RuntimeEvent) => void): () => void {
    const key = this.key(threadId);
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  getHistory(threadId: string): RuntimeEvent[] {
    return this.history.get(threadId) || [];
  }

  appendRecording(segment: RecordingSegment): void {
    const bucket = this.recordings.get(segment.threadId) || [];
    bucket.push(segment);
    if (bucket.length > MAX_RECORDINGS) {
      bucket.splice(0, bucket.length - MAX_RECORDINGS);
    }
    this.recordings.set(segment.threadId, bucket);
    this.emit({ eventName: "media_event", threadId: segment.threadId, segment });
  }

  getRecording(threadId: string, segmentId: string): RecordingSegment | null {
    const bucket = this.recordings.get(threadId) || [];
    return bucket.find((x) => x.segmentId === segmentId) || null;
  }

  getOptions(threadId: string): RuntimeOptions {
    return this.options.get(threadId) || DEFAULT_OPTIONS;
  }

  setOptions(threadId: string, patch: Partial<RuntimeOptions>): RuntimeOptions {
    const merged = { ...this.getOptions(threadId), ...patch };
    this.options.set(threadId, merged);
    return merged;
  }

  private key(threadId: string): string {
    return `thread:${threadId}`;
  }
}
