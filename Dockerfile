ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PACKING_DATA_DIR=/app/data \
    TZ=Asia/Shanghai

WORKDIR /app

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
    && apt-get install --no-install-recommends -y tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN addgroup --system app \
    && adduser --system --ingroup app --home /app app

COPY --chown=app:app app.py ./
COPY --chown=app:app migrate_sqlite_to_postgres.py ./
COPY --chown=app:app static ./static
COPY --chown=app:app templates ./templates
RUN mkdir -p /app/data && chown app:app /app/data

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/', timeout=3)" || exit 1

CMD ["waitress-serve", "--host=0.0.0.0", "--port=8080", "--threads=24", "app:app"]
