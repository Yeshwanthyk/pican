import noConditionalTests from "./oxlint-plugin-pican/rules/no-conditional-tests.js";
import noDoubleCast from "./oxlint-plugin-pican/rules/no-double-cast.js";
import noEffectEscapeHatch from "./oxlint-plugin-pican/rules/no-effect-escape-hatch.js";
import noEffectInternalTags from "./oxlint-plugin-pican/rules/no-effect-internal-tags.js";
import noErrorConstructor from "./oxlint-plugin-pican/rules/no-error-constructor.js";
import noInlineObjectTypeAssertion from "./oxlint-plugin-pican/rules/no-inline-object-type-assertion.js";
import noInlineSchemaCompile from "./oxlint-plugin-pican/rules/no-inline-schema-compile.js";
import noInstanceofError from "./oxlint-plugin-pican/rules/no-instanceof-error.js";
import noInstanceofTaggedError from "./oxlint-plugin-pican/rules/no-instanceof-tagged-error.js";
import noJsonParse from "./oxlint-plugin-pican/rules/no-json-parse.js";
import noManualTagCheck from "./oxlint-plugin-pican/rules/no-manual-tag-check.js";
import noMatchOrelse from "./oxlint-plugin-pican/rules/no-match-orelse.js";
import noPromiseCatch from "./oxlint-plugin-pican/rules/no-promise-catch.js";
import noPromiseClientSurface from "./oxlint-plugin-pican/rules/no-promise-client-surface.js";
import noPromiseReject from "./oxlint-plugin-pican/rules/no-promise-reject.js";
import noRawFetch from "./oxlint-plugin-pican/rules/no-raw-fetch.js";
import noRawErrorThrow from "./oxlint-plugin-pican/rules/no-raw-error-throw.js";
import noRedundantPrimitiveCast from "./oxlint-plugin-pican/rules/no-redundant-primitive-cast.js";
import noRedundantErrorFactory from "./oxlint-plugin-pican/rules/no-redundant-error-factory.js";
import noSchemaClass from "./oxlint-plugin-pican/rules/no-schema-class.js";
import noSwitchStatement from "./oxlint-plugin-pican/rules/no-switch-statement.js";
import noTsNocheck from "./oxlint-plugin-pican/rules/no-ts-nocheck.js";
import noTryCatchOrThrow from "./oxlint-plugin-pican/rules/no-try-catch-or-throw.js";
import noUnknownErrorMessage from "./oxlint-plugin-pican/rules/no-unknown-error-message.js";
import noUnknownShapeProbing from "./oxlint-plugin-pican/rules/no-unknown-shape-probing.js";
import noUnsupportedEffectApi from "./oxlint-plugin-pican/rules/no-unsupported-effect-api.js";
import preferEffectPredicate from "./oxlint-plugin-pican/rules/prefer-effect-predicate.js";
import preferSchemaInferredTypes from "./oxlint-plugin-pican/rules/prefer-schema-inferred-types.js";
import preferYieldTaggedError from "./oxlint-plugin-pican/rules/prefer-yield-tagged-error.js";
import preferValueInferredExtensionTypes from "./oxlint-plugin-pican/rules/prefer-value-inferred-extension-types.js";

export default {
  meta: {
    name: "pican",
  },
  rules: {
    "no-conditional-tests": noConditionalTests,
    "no-double-cast": noDoubleCast,
    "no-effect-escape-hatch": noEffectEscapeHatch,
    "no-effect-internal-tags": noEffectInternalTags,
    "no-error-constructor": noErrorConstructor,
    "no-ts-nocheck": noTsNocheck,
    "no-inline-object-type-assertion": noInlineObjectTypeAssertion,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-instanceof-error": noInstanceofError,
    "no-instanceof-tagged-error": noInstanceofTaggedError,
    "no-json-parse": noJsonParse,
    "no-manual-tag-check": noManualTagCheck,
    "no-match-orelse": noMatchOrelse,
    "no-promise-catch": noPromiseCatch,
    "no-promise-client-surface": noPromiseClientSurface,
    "no-promise-reject": noPromiseReject,
    "no-raw-fetch": noRawFetch,
    "no-raw-error-throw": noRawErrorThrow,
    "no-redundant-primitive-cast": noRedundantPrimitiveCast,
    "no-redundant-error-factory": noRedundantErrorFactory,
    "no-schema-class": noSchemaClass,
    "no-switch-statement": noSwitchStatement,
    "no-try-catch-or-throw": noTryCatchOrThrow,
    "no-unknown-error-message": noUnknownErrorMessage,
    "no-unknown-shape-probing": noUnknownShapeProbing,
    "no-unsupported-effect-api": noUnsupportedEffectApi,
    "prefer-effect-predicate": preferEffectPredicate,
    "prefer-schema-inferred-types": preferSchemaInferredTypes,
    "prefer-value-inferred-extension-types": preferValueInferredExtensionTypes,
    "prefer-yield-tagged-error": preferYieldTaggedError,
  },
};
