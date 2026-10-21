try {
  const results = await Promise.all([
    fetch('http://127.0.0.1:3001/health', { signal: AbortSignal.timeout(5000) }),
    fetch('http://127.0.0.1:3000/login', { signal: AbortSignal.timeout(5000), redirect: 'manual' }),
  ]);
  process.exit(results.every(response => response.status >= 200 && response.status < 400) ? 0 : 1);
} catch {
  process.exit(1);
}
