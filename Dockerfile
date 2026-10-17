# Build the web client and run the SpendLock server as one image.
FROM node:24-slim
WORKDIR /app

# Install workspace deps (tsx is a devDep, so install everything).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY demo/package.json demo/
RUN npm ci

# Build the web client, then bring in the server source.
COPY shared shared
COPY web web
RUN npm run build -w web
COPY server server

ENV NODE_ENV=production \
    SPENDGATE_PORT=8787 \
    SPENDGATE_DATA=/data
EXPOSE 8787

CMD ["npm", "run", "start", "-w", "server"]
