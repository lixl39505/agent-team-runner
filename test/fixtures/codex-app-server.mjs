let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      const response = process.cwd().includes('failure')
        ? { id: request.id, error: { message: 'fixture initialization failed' } }
        : { id: request.id, result: {} };
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (!process.cwd().includes('failure')) {
        process.stdout.write(`${JSON.stringify({ method: 'fixture/notification', params: {} })}\n`);
        process.stdout.write(`${JSON.stringify({ id: 'fixture/request', method: 'mcpServer/elicitation/request', params: {} })}\n`);
      }
    }
  }
});
