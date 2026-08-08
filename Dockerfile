FROM node:20-slim

# Chromium + puppeteer runtime dependencies (used by `debun detect`)
RUN apt-get update && apt-get install -y \
    curl \
    chromium \
    python3 \
    python3-venv \
    python3-pip \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./

ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install

COPY . .

RUN chmod +x debun.sh build-db.sh *-files.sh

# The raw corpora (tens of GB) and the constructed hash databases are NOT baked into the
# image; .dockerignore keeps them out. These work immediately on the shipped fixtures:
#
#   ./debun.sh run RQ1              # performance       -> Table 1,   Fig. 14
#   ./debun.sh run RQ2              # ablation          -> Table 2,    Fig. 15-16
#   ./debun.sh run RQ3              # library detection -> Table 5,    Fig. 17-18
#   ./debun.sh run RQ4              # version detection -> Table 6,    Fig. 19
#
# Two of these degrade without the hash databases: `run RQ1` reports DEBUN from its stored
# measurement instead of timing it live, and `run RQ2` skips Tables 3 and 4, which rescore
# every website. Both say so when they do it. To get them, build the databases first:
#
#   ./download-files.sh  # ~115 MB: the databases themselves, ready to use
#
# or rebuild them from source with ./corpora-files.sh and ./cdn-files.sh (the library corpus,
# from cdnjs), followed by ./build-db.sh.
#
# See the README's "Data" section for what each download unlocks, including which steps do
# not need the ~54 GB npm corpus.
CMD ["/bin/bash"]
