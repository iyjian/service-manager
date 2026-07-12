import type { ProxyTraffic } from '../../shared/types';

export interface ParsedTrafficChunk {
  records: ProxyTraffic[];
  remainder: string;
}

function toTrafficRecord(value: unknown): ProxyTraffic | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const { up, down } = value as { up?: unknown; down?: unknown };
  if (
    typeof up !== 'number' ||
    !Number.isFinite(up) ||
    up < 0 ||
    typeof down !== 'number' ||
    !Number.isFinite(down) ||
    down < 0
  ) {
    return null;
  }

  return { upBytesPerSecond: up, downBytesPerSecond: down };
}

/**
 * Frames the sequential JSON objects emitted by Mihomo's `/traffic` endpoint.
 * Mihomo does not delimit records, so this retains only a trailing incomplete
 * object for the next decoded stream chunk.
 */
export function extractTrafficRecords(input: string): ParsedTrafficChunk {
  const records: ProxyTraffic[] = [];
  let objectStart = -1;
  let depth = 0;
  let insideString = false;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (objectStart === -1) {
      if (character === '{') {
        objectStart = index;
        depth = 1;
        insideString = false;
        escaping = false;
      }
      continue;
    }

    if (insideString) {
      if (escaping) {
        escaping = false;
      } else if (character === '\\') {
        escaping = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }

    if (character === '"') {
      insideString = true;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character !== '}') {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    try {
      const record = toTrafficRecord(JSON.parse(input.slice(objectStart, index + 1)) as unknown);
      if (record) {
        records.push(record);
      }
    } catch {
      // A completed malformed record must not poison later valid records.
    }
    objectStart = -1;
  }

  return {
    records,
    remainder: objectStart === -1 ? '' : input.slice(objectStart),
  };
}
