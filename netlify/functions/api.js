const { connectLambda } = require('@netlify/blobs');
const serverless = require('serverless-http');
const { createApp } = require('../../api-app.js');

const app = createApp();
const serverlessHandler = serverless(app, {
  binary: ['image/*', 'application/octet-stream'],
});

exports.handler = (event, context) => {
  connectLambda(event);
  return serverlessHandler(event, context);
};
