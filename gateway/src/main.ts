import { loadConfig } from './config';
import { createGatewayServer } from './server';

const config = loadConfig();
const server = createGatewayServer(config);
const port = Number(process.env.PORT ?? 8788), host = process.env.GATEWAY_HOST ?? '127.0.0.1';
server.listen(port, host, () => console.log(JSON.stringify({ event: 'gateway_listening', host, port, tenants: config.tenants.size })));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
