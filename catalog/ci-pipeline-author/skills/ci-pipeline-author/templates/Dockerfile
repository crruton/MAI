FROM python:3.12-slim
# Credential-free URLs only; authenticated indexes require a build secret.
ARG PIP_INDEX_URL=https://pypi.org/simple
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY app app
USER 10001
CMD ["python", "-m", "app"]
