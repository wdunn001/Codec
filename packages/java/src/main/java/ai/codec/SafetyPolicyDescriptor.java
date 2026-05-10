// SPDX-License-Identifier: MIT
package ai.codec;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Sanitized, publishable safety-policy descriptor.
 *
 * <p>Java twin of {@code @codecai/web}'s {@code SafetyPolicyDescriptor}
 * (slice 1) and {@code codecai.SafetyPolicyDescriptor} (Python). Same
 * shapes, same canonical JSON form for hashing — descriptors that hash
 * to {@code sha256:abc…} in any client hash to the identical digest
 * here.
 *
 * <p>Fields with {@code null} values are omitted by Jackson via
 * {@link JsonInclude.Include#NON_NULL}, matching the Python/Rust/.NET
 * exclude-null behavior so the canonical bytes are byte-identical
 * across stacks.
 *
 * <p>See {@code spec/safety-policy.schema.json} for the normative
 * schema; {@link SafetyPolicy} for the validate/hash/load/discover
 * static utility surface.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class SafetyPolicyDescriptor {

    @JsonProperty("id")
    public String id;

    @JsonProperty("version")
    public String version;

    @JsonProperty("tokenizers")
    public List<String> tokenizers;

    @JsonProperty("categories")
    public List<Category> categories;

    @JsonProperty("category_registry")
    public String categoryRegistry;

    @JsonProperty("classifier")
    public ClassifierBlock classifier;

    @JsonProperty("rules_summary")
    public RulesSummary rulesSummary;

    @JsonProperty("client_hooks")
    public ClientHooksBlock clientHooks;

    @JsonProperty("published_at")
    public String publishedAt;

    @JsonProperty("publisher")
    public PublisherBlock publisher;

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Category {
        @JsonProperty("name") public String name;
        @JsonProperty("action") public String action;
        @JsonProperty("description") public String description;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ClassifierBlock {
        @JsonProperty("family") public String family;
        @JsonProperty("host") public String host;
        @JsonProperty("requires_engine_features") public List<String> requiresEngineFeatures;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class RulesSummary {
        @JsonProperty("banned_token_id_count") public Long bannedTokenIdCount;
        @JsonProperty("regex_pattern_count") public Long regexPatternCount;
        @JsonProperty("grammar_constraint_count") public Long grammarConstraintCount;
        @JsonProperty("multi_token_pattern_count") public Long multiTokenPatternCount;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ClientHooksBlock {
        @JsonProperty("prefilter_categories") public List<String> prefilterCategories;
        @JsonProperty("client_classifier_family") public String clientClassifierFamily;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class PublisherBlock {
        @JsonProperty("name") public String name;
        @JsonProperty("url") public String url;
        @JsonProperty("contact") public String contact;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Pointer {
        @JsonProperty("id") public String id;
        @JsonProperty("url") public String url;
        @JsonProperty("hash") public String hash;
        @JsonProperty("published_at") public String publishedAt;
    }
}
