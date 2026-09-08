FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY selftest.mjs ./
COPY provisioner.mjs ./
COPY bootstrap.mjs ./
COPY serverless-bootstrap.mjs ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "bootstrap.mjs"]
