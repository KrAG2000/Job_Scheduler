(function (window) {
    const SchedulerTracker = {
        endpoint: 'http://localhost:3001/track',
        apiKey: null,

        init: function (config) {
            this.apiKey = config.apiKey;
            this.endpoint = config.endpoint || this.endpoint;

            if (!this.apiKey) {
                console.error('SchedulerTracker: API Key required');
                return;
            }

            this.track('pageview', {
                url: window.location.href,
                referrer: document.referrer
            });

            window.addEventListener('click', (e) => {
                this.track('click', {
                    x: e.clientX,
                    y: e.clientY,
                    target: e.target.tagName,
                    id: e.target.id
                });
            });
        },

        track: function (type, data) {
            if (!this.apiKey) return;

            // A stable id per event lets the server de-duplicate if we retry.
            const eventId = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : Date.now() + '-' + Math.random().toString(36).slice(2);
            this.send({ type, data, eventId }, 0);
        },

        send: function (body, attempt) {
            fetch(this.endpoint, {
                method: 'POST',
                keepalive: true, // lets the request finish if the page is unloading
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey
                },
                body: JSON.stringify(body)
            }).then((res) => {
                if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                    setTimeout(() => this.send(body, attempt + 1), 1000 * Math.pow(2, attempt));
                }
            }).catch(() => {
                if (attempt < 3) setTimeout(() => this.send(body, attempt + 1), 1000 * Math.pow(2, attempt));
            });
        }
    };

    window.SchedulerTracker = SchedulerTracker;
})(window);
