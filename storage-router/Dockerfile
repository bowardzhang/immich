FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY selftest.mjs ./
COPY serverless-bootstrap.mjs ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "serverless-bootstrap.mjs"]
