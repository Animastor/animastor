FROM node:20-bookworm

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install -g npm@11 && npm install --omit=dev --ignore-scripts

COPY . .

CMD ["node", "src/backend.cjs"]
