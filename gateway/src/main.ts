import { loadConfig } from './config';
import { createGatewayServer } from './server';

function boot() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration errors already name the file and the problem; do not print values or a stack
    // that could contain a vendor key.
    console.error(JSON.stringify({ event: 'gateway_config_error', message: error instanceof Error ? error.message : 'unknown configuration error' }));
    process.exit(1);
  }

  for (const warning of config.warnings) console.warn(JSON.stringify({ event: 'gateway_config_warning', message: warning }));

  const server = createGatewayServer(config);
  const port = Number(process.env.PORT ?? 8788), host = process.env.GATEWAY_HOST ?? '127.0.0.1';
  server.on('error', error => {
    console.error(JSON.stringify({ event: 'gateway_listen_failed', message: error instanceof Error ? error.message : 'unknown listen error' }));
    process.exit(1);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(JSON.stringify({
      event: 'gateway_listening', host, port: boundPort, tenants: config.tenants.size,
      taxonomyFile: config.taxonomyFile ?? null,
      taxonomy: { industries: Object.keys(config.taxonomy.industries).length, titles: Object.keys(config.taxonomy.titles).length }
    }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

boot();
