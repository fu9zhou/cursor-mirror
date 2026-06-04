FROM node:18-alpine

RUN apk add --no-cache curl bash

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ src/
COPY public/ public/
COPY config.example.json ./

RUN mkdir -p downloads logs

RUN curl -fsSL https://raw.githubusercontent.com/wps365-open/cli/main/install.sh | bash || true

ENV WPS365_KEYRING_BACKEND=file
ENV WPS365_CONFIG_DIR=/app/wps365-config

EXPOSE 6700

CMD ["node", "src/index.js"]
