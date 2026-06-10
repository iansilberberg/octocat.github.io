const { createApp } = require('./api-app.js');

const app = createApp({ serveStatic: true });
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`QTI listo en http://localhost:${port}`);
});
