// @vitest-environment node
// WI-RA18.4 — the AI suggestion ghost text strips the serializer's escapes
// and collapses autolinks, for display only. Moved with the function from
// markdownCopy, whose copied markdown keeps every escape.
import { describe, it, expect } from "vitest";
import { suggestionDisplayText } from "./displayText";

describe("suggestionDisplayText", () => {
  describe("backslash escape stripping", () => {
    it("strips escaped dollar signs", () => {
      expect(suggestionDisplayText("Price is \\$99.99")).toBe(
        "Price is $99.99"
      );
    });

    it("strips escaped tildes", () => {
      expect(suggestionDisplayText("\\~20% off")).toBe("~20% off");
    });

    it("strips escaped at signs", () => {
      expect(suggestionDisplayText("user\\@example.com")).toBe(
        "user@example.com"
      );
    });

    it("strips escaped brackets", () => {
      expect(suggestionDisplayText("\\[not a link]")).toBe("[not a link]");
    });

    it("strips escaped asterisks", () => {
      expect(suggestionDisplayText("5 \\* 3 = 15")).toBe("5 * 3 = 15");
    });

    it("strips escaped underscores", () => {
      expect(suggestionDisplayText("snake\\_case")).toBe("snake_case");
    });

    it("strips escaped colons", () => {
      expect(suggestionDisplayText("https\\://example.com")).toBe(
        "https://example.com"
      );
    });

    it("strips escaped ampersands", () => {
      expect(suggestionDisplayText("foo\\&bar")).toBe("foo&bar");
    });

    it("converts double backslash to single", () => {
      expect(suggestionDisplayText("C:\\\\Users\\\\foo")).toBe(
        "C:\\Users\\foo"
      );
    });

    it("does not strip backslash before newline", () => {
      expect(suggestionDisplayText("line1\\\nline2")).toBe(
        "line1\\\nline2"
      );
    });

    it("handles multiple escapes in one line", () => {
      expect(
        suggestionDisplayText("\\$99 is \\~20% off\\!")
      ).toBe("$99 is ~20% off!");
    });
  });

  describe("autolink collapsing", () => {
    it("collapses URL autolinks", () => {
      expect(
        suggestionDisplayText(
          "[https://example.com/path](https://example.com/path)"
        )
      ).toBe("https://example.com/path");
    });

    it("collapses mailto autolinks", () => {
      expect(
        suggestionDisplayText(
          "[user@example.com](mailto:user@example.com)"
        )
      ).toBe("user@example.com");
    });

    it("collapses autolinks with escaped chars in text", () => {
      // Serializer escapes @ in text but not in URL
      expect(
        suggestionDisplayText(
          "[user\\@example.com](mailto:user@example.com)"
        )
      ).toBe("user@example.com");
    });

    it("collapses URL autolinks with escaped colons", () => {
      expect(
        suggestionDisplayText(
          "[https\\://example.com](https://example.com)"
        )
      ).toBe("https://example.com");
    });

    it("preserves real links where text differs from URL", () => {
      expect(
        suggestionDisplayText("[click here](https://example.com)")
      ).toBe("[click here](https://example.com)");
    });
  });

  describe("preserves markdown syntax", () => {
    it("preserves bold", () => {
      expect(suggestionDisplayText("**bold**")).toBe("**bold**");
    });

    it("preserves italic", () => {
      expect(suggestionDisplayText("*italic*")).toBe("*italic*");
    });

    it("preserves strikethrough", () => {
      expect(suggestionDisplayText("~~deleted~~")).toBe("~~deleted~~");
    });

    it("preserves code spans", () => {
      expect(suggestionDisplayText("`code`")).toBe("`code`");
    });

    it("preserves headings", () => {
      expect(suggestionDisplayText("## Heading")).toBe("## Heading");
    });

    it("preserves fenced code blocks", () => {
      const input = "```js\nconst x = 1;\n```";
      expect(suggestionDisplayText(input)).toBe(input);
    });
  });

  describe("does not strip unknown escapes", () => {
    it("preserves backslash before letters", () => {
      expect(suggestionDisplayText("\\n \\t")).toBe("\\n \\t");
    });

    it("preserves backslash before digits", () => {
      expect(suggestionDisplayText("item \\1")).toBe("item \\1");
    });

    it("preserves backslash before space", () => {
      expect(suggestionDisplayText("foo\\ bar")).toBe("foo\\ bar");
    });
  });
});

describe("ensureBlockContent via suggestionDisplayText integration", () => {
  it("handles input with only markdown formatting", () => {
    expect(suggestionDisplayText("**bold** *italic* `code`")).toBe(
      "**bold** *italic* `code`"
    );
  });

  it("handles escaped exclamation mark", () => {
    expect(suggestionDisplayText("\\!important")).toBe("!important");
  });

  it("handles consecutive escapes", () => {
    expect(suggestionDisplayText("\\$\\$math\\$\\$")).toBe("$$math$$");
  });
});

describe("suggestionDisplayText — additional edge cases", () => {
  it("handles empty string", () => {
    expect(suggestionDisplayText("")).toBe("");
  });

  it("strips escaped hash marks", () => {
    expect(suggestionDisplayText("\\# Not a heading")).toBe("# Not a heading");
  });

  it("strips escaped pipes", () => {
    expect(suggestionDisplayText("col1 \\| col2")).toBe("col1 | col2");
  });

  it("strips escaped parentheses", () => {
    expect(suggestionDisplayText("fn\\(x\\)")).toBe("fn(x)");
  });

  it("strips escaped closing bracket", () => {
    expect(suggestionDisplayText("\\[foo\\]")).toBe("[foo]");
  });

  it("strips escaped plus sign", () => {
    expect(suggestionDisplayText("\\+ item")).toBe("+ item");
  });

  it("strips escaped dot", () => {
    expect(suggestionDisplayText("1\\. not ordered")).toBe("1. not ordered");
  });

  it("strips escaped greater-than", () => {
    expect(suggestionDisplayText("\\> not blockquote")).toBe("> not blockquote");
  });

  it("strips escaped hyphen/dash", () => {
    expect(suggestionDisplayText("\\- not list")).toBe("- not list");
  });

  it("strips escaped backtick", () => {
    expect(suggestionDisplayText("\\`not code\\`")).toBe("`not code`");
  });

  it("handles combined escape stripping and autolink collapse", () => {
    const input = "Visit [https\\://example.com](https://example.com) for \\$5 off";
    expect(suggestionDisplayText(input)).toBe(
      "Visit https://example.com for $5 off"
    );
  });

  it("handles multiple autolinks in one string", () => {
    const input =
      "[https://a.com](https://a.com) and [https://b.com](https://b.com)";
    expect(suggestionDisplayText(input)).toBe(
      "https://a.com and https://b.com"
    );
  });

  it("does not collapse link with different text and URL", () => {
    expect(
      suggestionDisplayText("[Example](https://example.com)")
    ).toBe("[Example](https://example.com)");
  });

  it("handles nested markdown formatting", () => {
    expect(suggestionDisplayText("**bold and *italic***")).toBe(
      "**bold and *italic***"
    );
  });
});
