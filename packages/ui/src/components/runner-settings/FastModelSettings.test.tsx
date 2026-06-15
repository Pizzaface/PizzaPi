import { describe, expect, test, mock, afterAll } from "bun:test";

// Stub the UI component imports so the module resolves without a DOM environment.
mock.module("@/components/ui/button", () => {
    const R = require("react");
    const Button = R.forwardRef((props, ref) =>
        R.createElement("button", { ref, ...props }, props.children),
    );
    Button.displayName = "Button";
    return { Button };
});

mock.module("@/components/ui/input", () => {
    const R = require("react");
    const Input = R.forwardRef((props, ref) =>
        R.createElement("input", { ref, ...props }),
    );
    Input.displayName = "Input";
    return { Input };
});

mock.module("@/components/ui/label", () => {
    const R = require("react");
    const Label = (props) => R.createElement("label", props, props.children);
    return { Label };
});

mock.module("@/components/ui/select", () => {
    const R = require("react");
    const Select = (props) => R.createElement("div", null, props.children);
    const SelectContent = (props) => R.createElement("div", null, props.children);
    const SelectItem = (props) => R.createElement("div", null, props.children);
    const SelectTrigger = (props) => R.createElement("div", null, props.children);
    const SelectValue = (props) => R.createElement("span", null, props.placeholder ?? "");
    return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

mock.module("@/lib/utils", () => ({
    cn: (...args) => args.filter(Boolean).join(" "),
}));

afterAll(() => mock.restore());

const { parseEvaluatorModel } = await import("./FastModelSettings");

describe("parseEvaluatorModel", () => {
    test("splits provider:modelId format", () => {
        expect(parseEvaluatorModel("anthropic:claude-3-5-haiku-latest")).toEqual({
            provider: "anthropic",
            modelId: "claude-3-5-haiku-latest",
        });
    });

    test("keeps bare modelId with empty provider", () => {
        expect(parseEvaluatorModel("claude-3-5-haiku-latest")).toEqual({
            provider: "",
            modelId: "claude-3-5-haiku-latest",
        });
    });

    test("returns empty values for undefined", () => {
        expect(parseEvaluatorModel(undefined)).toEqual({ provider: "", modelId: "" });
    });

    test("returns empty values for empty string", () => {
        expect(parseEvaluatorModel("")).toEqual({ provider: "", modelId: "" });
    });

    test("ignores malformed strings with empty segments", () => {
        expect(parseEvaluatorModel(":")).toEqual({ provider: "", modelId: ":" });
        expect(parseEvaluatorModel("anthropic:")).toEqual({ provider: "", modelId: "anthropic:" });
        expect(parseEvaluatorModel(":claude")).toEqual({ provider: "", modelId: ":claude" });
    });
});
