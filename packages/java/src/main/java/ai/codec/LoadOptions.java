// SPDX-License-Identifier: MIT
package ai.codec;

import java.net.http.HttpClient;

/** Options for {@link MapLoader#load(LoadOptions)}. */
public final class LoadOptions {
    private final String url;
    private final String hash;
    private final MapCache cache;
    private final HttpClient http;
    private final String cacheKey;

    private LoadOptions(Builder b) {
        if (b.url == null || b.url.isEmpty())
            throw new IllegalArgumentException("LoadOptions.url is required");
        this.url = b.url;
        this.hash = b.hash;
        this.cache = b.cache;
        this.http = b.http;
        this.cacheKey = b.cacheKey;
    }

    public String url() { return url; }
    public String hash() { return hash; }
    public MapCache cache() { return cache; }
    public HttpClient http() { return http; }
    public String cacheKey() { return cacheKey; }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String url;
        private String hash;
        private MapCache cache;
        private HttpClient http;
        private String cacheKey;

        public Builder url(String v)        { this.url = v; return this; }
        public Builder hash(String v)       { this.hash = v; return this; }
        public Builder cache(MapCache v)    { this.cache = v; return this; }
        public Builder http(HttpClient v)   { this.http = v; return this; }
        public Builder cacheKey(String v)   { this.cacheKey = v; return this; }

        public LoadOptions build() { return new LoadOptions(this); }
    }
}
