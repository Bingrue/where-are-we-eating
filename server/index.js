import express from 'express';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const clientDist = fileURLToPath(new URL('../client/dist/', import.meta.url));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(express.static(clientDist));

app.listen(port, () => {
  console.log(`Express listening on port ${port}`);
});
