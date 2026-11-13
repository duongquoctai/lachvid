FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR $HOME/app

COPY --chown=user:user backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY --chown=user:user package*.json ./
RUN npm ci

COPY --chown=user:user . .
RUN npm run build && chmod +x start.sh

ENV NODE_ENV=production

USER user
EXPOSE 3005
CMD ["./start.sh"]
