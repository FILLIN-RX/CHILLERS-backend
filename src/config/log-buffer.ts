import { Response } from 'express';

const MAX_LINES = 2000;
const buffer: string[] = [];
const clients: Response[] = [];

export function appendLog(line: string) {
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();
  for (const client of clients) {
    client.write(`data: ${JSON.stringify({ line })}\n\n`);
  }
}

export function getLogs(limit = 200): string[] {
  return buffer.slice(-limit);
}

export function getAllLogs(): string[] {
  return [...buffer];
}

export function addSSEClient(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const line of buffer) {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }
  clients.push(res);
  res.on('close', () => {
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
}
