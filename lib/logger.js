const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Tiny dependency-free logger. Text mode by default, JSON when LOG_FORMAT=json.
 */
export function createLogger({ level = 'info', format = 'text', name = 'm3urelay' } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const json = String(format).toLowerCase() === 'json';

  const emit = (severity, args) => {
    if (LEVELS[severity] > threshold) return;
    const time = new Date().toISOString();
    if (json) {
      const [message, meta] = args;
      const record = { time, level: severity, name, msg: message };
      if (meta && typeof meta === 'object' && !(meta instanceof Error)) Object.assign(record, meta);
      if (meta instanceof Error) record.err = meta.message;
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const [message, meta] = args;
    const suffix =
      meta === undefined
        ? ''
        : meta instanceof Error
          ? ` ${meta.stack || meta.message}`
          : ` ${safeJson(meta)}`;
    process.stdout.write(`${time} ${severity.toUpperCase().padEnd(5)} ${name} ${message}${suffix}\n`);
  };

  return {
    level,
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),
    child: (childName) => createLogger({ level, format, name: `${name}:${childName}` }),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
