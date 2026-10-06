/**
 * Language Detection Patterns
 *
 * Regex patterns for identifying programming languages in text.
 *
 * @module utils/codeDetection/patterns
 */

/**
 * Common programming language keywords and patterns.
 */
export const LANGUAGE_PATTERNS: Record<string, { keywords: RegExp[]; patterns: RegExp[] }> = {
  javascript: {
    keywords: [
      /\b(const|let|var|function|class|import|export|async|await|return|if|else|for|while)\b/,
      /\b(undefined|null|true|false|new|this|typeof|instanceof)\b/,
    ],
    patterns: [
      /=>\s*{/, // arrow functions
      /\(\s*\)\s*=>/, // arrow functions
      /\$\{[^}]+\}/, // template literals
      /require\s*\(/, // CommonJS
      /import\s+.*\s+from\s+['"]/, // ES modules
    ],
  },
  typescript: {
    keywords: [
      /\b(interface|type|enum|namespace|declare|readonly|as|implements|extends)\b/,
      /:\s*(string|number|boolean|void|any|unknown|never)\b/,
    ],
    patterns: [
      /<[A-Z][a-zA-Z]*>/, // generics
      /\?\s*:/, // optional properties
    ],
  },
  python: {
    keywords: [
      /\b(def|class|import|from|return|if|elif|else|for|while|with|as|try|except|finally|raise|yield|lambda|pass|break|continue)\b/,
      /\b(None|True|False|self|cls)\b/,
    ],
    patterns: [
      /^\s*def\s+\w+\s*\(/, // function definition
      /^\s*class\s+\w+/, // class definition
      /^\s*@\w+/, // decorators
      /:\s*$/, // colon at end of line
    ],
  },
  rust: {
    keywords: [
      /\b(fn|let|mut|const|struct|enum|impl|trait|pub|mod|use|crate|self|super|where|match|if|else|loop|while|for|return|break|continue)\b/,
      /\b(i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc)\b/,
    ],
    patterns: [
      /->/, // return type
      /::/, // path separator
      /&mut\s+\w+/, // mutable references
      /\?;/, // error propagation
      /#\[[\w:]+\]/, // attributes
    ],
  },
  go: {
    keywords: [
      /\b(func|var|const|type|struct|interface|package|import|return|if|else|for|range|switch|case|default|defer|go|chan|select|map|make|new)\b/,
    ],
    patterns: [
      /func\s+\(\w+\s+\*?\w+\)/, // method receiver
      /:=/, // short variable declaration
      /^\s*package\s+\w+/, // package declaration
      /^\s*import\s+[("]/,
    ],
  },
  java: {
    keywords: [
      /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|void|new|return|if|else|for|while|try|catch|finally|throw|throws)\b/,
      /\b(int|long|double|float|boolean|char|byte|short|String|Integer|Long|Double|Boolean)\b/,
    ],
    patterns: [
      /@Override/, // annotations
      /System\.out\.print/, // common pattern
      /new\s+\w+\s*\(/, // object creation
    ],
  },
  cpp: {
    keywords: [
      /\b(class|struct|template|typename|namespace|using|public|private|protected|virtual|override|const|static|void|int|long|double|float|char|bool|auto|return|if|else|for|while|switch|case|default|break|continue|new|delete|nullptr|this)\b/,
    ],
    patterns: [
      /std::/, // standard library
      /#include\s*</, // includes
      /::/, // scope resolution
      /->/, // pointer member access
    ],
  },
  html: {
    keywords: [],
    patterns: [
      /<(!DOCTYPE|html|head|body|div|span|p|a|img|script|style|link|meta|form|input|button|table|tr|td|th|ul|ol|li|h[1-6])[^>]*>/i,
      /<\/\w+>/,
    ],
  },
  css: {
    keywords: [],
    patterns: [
      /[.#][\w-]+\s*\{/, // selectors
      /\{\s*[\w-]+\s*:/, // property declarations
      /@(import|media|keyframes|font-face)/,
    ],
  },
  json: {
    keywords: [],
    patterns: [
      /^\s*\{[\s\S]*\}\s*$/, // object
      /^\s*\[[\s\S]*\]\s*$/, // array
      /"[^"]+"\s*:\s*/, // key-value pairs
    ],
  },
  yaml: {
    keywords: [],
    patterns: [
      /^\s*[\w-]+:\s*[|>-]?\s*$/, // key with block scalar
      /^\s*[\w-]+:\s+\S/, // key with value
      /^\s*-\s+/, // list items
    ],
  },
  shell: {
    keywords: [
      /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|alias|cd|pwd|ls|cat|grep|sed|awk|find|xargs)\b/,
    ],
    patterns: [
      /^\s*#!\//, // shebang
      /\$\{?\w+\}?/, // variable expansion
      /\|\s*\w+/, // pipes
      /&&\s*\w+/, // command chaining
    ],
  },
  sql: {
    keywords: [
      /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|JOIN|INNER|LEFT|RIGHT|OUTER|ON|AND|OR|NOT|NULL|IN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AS|DISTINCT)\b/i,
    ],
    patterns: [
      /^\s*SELECT\s+/i,
      /^\s*INSERT\s+INTO/i,
      /^\s*UPDATE\s+\w+\s+SET/i,
      /^\s*CREATE\s+TABLE/i,
    ],
  },
};

/**
 * Generic code patterns that indicate source code regardless of language.
 */
export const GENERIC_CODE_PATTERNS = [
  // Consistent indentation (multiple lines with same indent)
  /^(\s{2,}|\t)\S/m,
  // Brackets and braces (common in most languages)
  /[{}[\]()]+/,
  // Assignment operators
  /[=!<>]=|[+\-*/%]=|\+\+|--/,
  // Logical operators
  /&&|\|\|/,
  // Comments
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/,
  // String literals with escapes
  /["'`].*\\[nrt\\'"]/,
  // Semicolons at end of lines
  /;\s*$/m,
  // Function-like patterns
  /\w+\s*\([^)]*\)/,
];

/**
 * Patterns that indicate NON-code content.
 */
export const NON_CODE_PATTERNS = [
  // Prose-like sentences with proper capitalization and punctuation
  /^[A-Z][^.!?]*[.!?]\s*$/m,
  // Multiple sentences in paragraph form
  /[.!?]\s+[A-Z]/,
  // Common prose words at start
  /^(The|A|An|I|We|You|He|She|It|They|This|That|These|Those|In|On|At|For|To|From)\s/i,
];
