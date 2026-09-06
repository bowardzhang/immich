FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY selftest.mjs ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["sh", "-c", "node selftest.mjs && exec node server.mjs"]
