import { EventEmitter } from "node:events";
import { createLogger, format, transports } from "winston";

export const logStream = new EventEmitter();
logStream.setMaxListeners(100);

function stripAnsi(value = "") {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "");
}

function emitAndFormatLine({ timestamp, level, message, ...meta }) {
  const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  const plainLevel = stripAnsi(level);
  const plainLine = `${timestamp} [${plainLevel}]: ${message}${metaStr}`;

  logStream.emit("line", {
    at: timestamp || new Date().toISOString(),
    line: plainLine,
  });

  return `${timestamp} [${level}]: ${message}${metaStr}`;
}

export const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json(),
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(emitAndFormatLine),
      ),
    }),
  ],
});
