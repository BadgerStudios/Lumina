# Outbound SMTP relay. See relay.py for why this service exists and why it is not an open relay.
FROM python:3.12-alpine

# `dig` — _resolve_mx() shells out to it rather than pulling in a DNS library for one query shape.
# Without this the MX lookup silently falls back to the A record for every domain, which happens to
# work for some hosts and fails for Gmail, so it would look like an intermittent bug rather than a
# missing package.
RUN apk add --no-cache bind-tools \
 && pip install --no-cache-dir aiosmtpd==1.4.6

# Non-root, matching every other service in this stack. Nothing here needs privileged ports: the
# relay listens on 2525 inside the Docker network, and outbound connections to port 25 do not
# require privilege — only binding low ports does.
RUN adduser -D -u 10001 relay
USER relay

WORKDIR /app
COPY services/mail-relay/relay.py /app/relay.py

CMD ["python", "-u", "relay.py"]
