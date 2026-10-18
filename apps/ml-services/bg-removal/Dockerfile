# syntax=docker/dockerfile:1
FROM python:3.12.7-slim-bookworm AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /build
COPY requirements.txt ./
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY models.lock.json ./
COPY scripts/fetch_models.py ./scripts/fetch_models.py
# Models come from their official release URLs and are verified against models.lock.json. A null hash fails the
# build unless ALLOW_UNPINNED_MODELS=1 is passed explicitly (never for production).
ARG ALLOW_UNPINNED_MODELS=0
ENV ALLOW_UNPINNED_MODELS=${ALLOW_UNPINNED_MODELS}
RUN python scripts/fetch_models.py --dest /opt/models

FROM python:3.12.7-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 U2NET_HOME=/opt/models OMP_NUM_THREADS=2 PATH=/opt/venv/bin:$PATH
RUN groupadd --system --gid 10001 bg && useradd --system --uid 10001 --gid bg --no-create-home --shell /usr/sbin/nologin bg
COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=root:root /opt/models /opt/models
WORKDIR /srv
COPY app ./app
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status == 200 else 1)"]
# Runtime has no outbound network need: deploy with an egress-deny policy (see README).
CMD ["uvicorn", "app.main:factory", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--workers", "1"]
