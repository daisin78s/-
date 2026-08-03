(function () {
/**
 * DSL tokenizer/parser for card and area effect strings (ONCE/TAP/PASSIVE/TURNEND/ACTION columns).
 * No DOM dependency. Pure string -> AST. Executor (not implemented yet) will walk the AST.
 *
 * Grammar (informal EBNF):
 *   program      := statement (';' statement)*
 *   statement    := assignment | call
 *   assignment   := IDENT ('.' IDENT)+ '=' IDENT
 *   call         := IDENT '(' arg_list? ')'
 *   arg_list     := arg (',' arg)*
 *   arg          := (group | quantity | call | ident_tail | number) arith_tail? ('*' ident_tail)? comparison_tail?
 *   group        := '(' arg_list ')'                      // e.g. the inner "(A,B,C)" of "((A,B,C))"
 *   quantity     := NUMBER IDENT ident_suffix?             // e.g. 2A, 3K (literal count)
 *                 | arg '*' ident_tail                     // e.g. COUNT(天)*wD (dynamic/expression count)
 *   arith_tail   := SIGNED_NUMBER+                         // e.g. (COUNT(天)-1) -- offsets a dynamic
 *                                                           //   count expression, not a general expression
 *                                                           //   language; not valid on a bare Number/Quantity
 *   comparison_tail := COMPARATOR NUMBER                   // e.g. CARD_COUNT<=6, LEVEL_COUNT(1)>=1
 *   ident_tail   := IDENT (call_args | ident_suffix)?      // IDENT, IDENT(...), or IDENT+suffix
 *   ident_suffix := (NUMBER ('|' NUMBER)*) | ('±' NUMBER)   // SELF2|3, SELF±1
 *   number       := NUMBER | SIGNED_NUMBER                 // 7, -2, +1
 */

'use strict';

class DslParseError extends Error {
  constructor(message, pos) {
    super(`${message} (position ${pos})`);
    this.name = 'DslParseError';
    this.pos = pos;
  }
}

const IDENT_START = /[A-Za-z_぀-ヿ一-鿿]/;
const IDENT_CONT = /[A-Za-z0-9_぀-ヿ一-鿿]/;
const DIGIT = /[0-9]/;

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(', pos: i }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')', pos: i }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'COMMA', value: ',', pos: i }); i++; continue; }
    if (ch === ';') { tokens.push({ type: 'SEMI', value: ';', pos: i }); i++; continue; }
    if (ch === '.') { tokens.push({ type: 'DOT', value: '.', pos: i }); i++; continue; }
    if (ch === '|') { tokens.push({ type: 'PIPE', value: '|', pos: i }); i++; continue; }
    if (ch === '*') { tokens.push({ type: 'STAR', value: '*', pos: i }); i++; continue; }
    if (ch === '±') { tokens.push({ type: 'PLUSMINUS', value: '±', pos: i }); i++; continue; }

    if (ch === '<' || ch === '>' || ch === '=' || ch === '!') {
      const two = input.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
        tokens.push({ type: 'COMPARATOR', value: two, pos: i });
        i += 2;
        continue;
      }
      if (ch === '<' || ch === '>') {
        tokens.push({ type: 'COMPARATOR', value: ch, pos: i });
        i++;
        continue;
      }
      if (ch === '=') { tokens.push({ type: 'EQUALS', value: '=', pos: i }); i++; continue; }
      throw new DslParseError(`Unexpected character '${ch}'`, i);
    }

    if (ch === '+' || ch === '-') {
      if (DIGIT.test(input[i + 1] || '')) {
        let j = i + 1;
        while (j < n && DIGIT.test(input[j])) j++;
        tokens.push({ type: 'SIGNED_NUMBER', value: input.slice(i, j), pos: i });
        i = j;
        continue;
      }
      throw new DslParseError(`Unexpected character '${ch}'`, i);
    }

    if (DIGIT.test(ch)) {
      let j = i;
      while (j < n && DIGIT.test(input[j])) j++;
      tokens.push({ type: 'NUMBER', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_CONT.test(input[j])) j++;
      tokens.push({ type: 'IDENT', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    throw new DslParseError(`Unexpected character '${ch}' (charcode ${input.codePointAt(i)})`, i);
  }

  tokens.push({ type: 'EOF', value: null, pos: n });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  peek() { return this.tokens[this.i]; }

  consume() { return this.tokens[this.i++]; }

  expect(type) {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new DslParseError(`Expected ${type} but got ${tok.type} ('${tok.value}')`, tok.pos);
    }
    return this.consume();
  }

  parseProgram() {
    const statements = [];
    if (this.peek().type !== 'EOF') {
      statements.push(this.parseStatement());
      while (this.peek().type === 'SEMI') {
        this.consume();
        statements.push(this.parseStatement());
      }
    }
    this.expect('EOF');
    return { type: 'Program', statements };
  }

  parseStatement() {
    const identTok = this.expect('IDENT');
    if (this.peek().type === 'DOT') {
      const path = [identTok.value];
      while (this.peek().type === 'DOT') {
        this.consume();
        path.push(this.expect('IDENT').value);
      }
      this.expect('EQUALS');
      const valueTok = this.expect('IDENT');
      return { type: 'Assignment', path, value: valueTok.value };
    }
    if (this.peek().type === 'LPAREN') {
      return this.parseCall(identTok);
    }
    throw new DslParseError(
      `Expected '(' or '.' after identifier '${identTok.value}'`,
      this.peek().pos
    );
  }

  parseCall(nameTok) {
    this.expect('LPAREN');
    const args = [];
    if (this.peek().type !== 'RPAREN') {
      args.push(this.parseArg());
      while (this.peek().type === 'COMMA') {
        this.consume();
        args.push(this.parseArg());
      }
    }
    this.expect('RPAREN');
    return { type: 'Call', name: nameTok.value, args };
  }

  parseIdentTail(identTok) {
    if (this.peek().type === 'LPAREN') {
      return this.parseCall(identTok);
    }
    // A trailing-digit choice list (e.g. "SELF2|3") lexes as a single IDENT
    // token ("SELF2") because identifiers may legitimately contain digits
    // (AREA001B, MAP003, ...). Only split off the digits as the first choice
    // when a '|' actually follows -- otherwise "AREA001B" etc. stay intact.
    if (this.peek().type === 'PIPE') {
      const m = identTok.value.match(/^([A-Za-z_぀-ヿ一-鿿]+)([0-9]+)$/);
      if (!m) {
        throw new DslParseError(
          `'|' choice list must follow a trailing number (e.g. SELF2|3), got '${identTok.value}|'`,
          this.peek().pos
        );
      }
      const [, base, firstDigits] = m;
      const choices = [Number(firstDigits)];
      while (this.peek().type === 'PIPE') {
        this.consume();
        choices.push(Number(this.expect('NUMBER').value));
      }
      return { type: 'Ident', name: base, choices };
    }
    if (this.peek().type === 'PLUSMINUS') {
      this.consume();
      const n = Number(this.expect('NUMBER').value);
      return { type: 'Ident', name: identTok.value, plusMinus: n };
    }
    return { type: 'Ident', name: identTok.value };
  }

  parseArg() {
    let node;
    const tok = this.peek();

    if (tok.type === 'LPAREN') {
      this.consume();
      const items = [];
      if (this.peek().type !== 'RPAREN') {
        items.push(this.parseArg());
        while (this.peek().type === 'COMMA') {
          this.consume();
          items.push(this.parseArg());
        }
      }
      this.expect('RPAREN');
      node = { type: 'Group', items };
    } else if (tok.type === 'SIGNED_NUMBER') {
      this.consume();
      node = { type: 'Number', value: Number(tok.value) };
    } else if (tok.type === 'NUMBER') {
      this.consume();
      if (this.peek().type === 'IDENT') {
        const identTok = this.consume();
        const resource = this.parseIdentTail(identTok);
        node = { type: 'Quantity', count: { type: 'Number', value: Number(tok.value) }, resource };
      } else {
        node = { type: 'Number', value: Number(tok.value) };
      }
    } else if (tok.type === 'IDENT') {
      this.consume();
      node = this.parseIdentTail(tok);
    } else {
      throw new DslParseError(`Unexpected token ${tok.type} ('${tok.value}')`, tok.pos);
    }

    // Arithmetic offset on a dynamic count expression, e.g. "COUNT(天)-1" == "that count, minus 1".
    // Repeatable (e.g. "COUNT(天)-1-1") but only meaningful on an expression (Call/Group/BinaryOp) --
    // not on an already-literal Number/Quantity, where '+1'/'−1' would just be a second, unrelated arg.
    while (this.peek().type === 'SIGNED_NUMBER') {
      if (node.type === 'Number' || node.type === 'Quantity') {
        throw new DslParseError(`Cannot apply arithmetic '${this.peek().value}' to a ${node.type}`, this.peek().pos);
      }
      const opTok = this.consume();
      node = {
        type: 'BinaryOp',
        op: opTok.value[0],
        left: node,
        right: { type: 'Number', value: Number(opTok.value.slice(1)) },
      };
    }

    // Dynamic quantity: EXPR '*' IDENT, e.g. "COUNT(天)*wD" == "that many wD".
    // Only meaningful when the count so far isn't already a literal Quantity.
    if (this.peek().type === 'STAR') {
      if (node.type === 'Quantity') {
        throw new DslParseError("Cannot use '*' after a literal quantity (e.g. '2A*wD')", this.peek().pos);
      }
      this.consume();
      const identTok = this.expect('IDENT');
      const resource = this.parseIdentTail(identTok);
      node = { type: 'Quantity', count: node, resource };
    }

    if (this.peek().type === 'COMPARATOR') {
      const op = this.consume().value;
      const rhsTok = this.peek();
      if (rhsTok.type !== 'NUMBER' && rhsTok.type !== 'SIGNED_NUMBER') {
        throw new DslParseError(
          `Expected number after comparator '${op}' but got ${rhsTok.type}`,
          rhsTok.pos
        );
      }
      this.consume();
      node = {
        type: 'Comparison',
        left: node,
        op,
        right: { type: 'Number', value: Number(rhsTok.value) },
      };
    }

    return node;
  }
}

function parse(input) {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parseProgram();
}

/**
 * Parses a bare comma-separated arg list with no wrapping call, e.g. a data
 * sheet's COST column ("2A,2B,2C", "4A,B", "10B"). Reuses the same arg
 * grammar as function-call arguments (see Parser.parseArg) since COST
 * strings are exactly that grammar with the enclosing "FN(...)" omitted.
 * @param {string} input
 * @returns {Object[]} array of arg AST nodes (Quantity/Ident/Group/...)
 */
function parseArgList(input) {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  const args = [];
  if (parser.peek().type !== 'EOF') {
    args.push(parser.parseArg());
    while (parser.peek().type === 'COMMA') {
      parser.consume();
      args.push(parser.parseArg());
    }
  }
  parser.expect('EOF');
  return args;
}

/**
 * Never throws. Returns { success: true, ast } or { success: false, error: { message, pos } }.
 */
function parseSafe(input) {
  if (input === '' || input === null || input === undefined) {
    return { success: true, ast: { type: 'Program', statements: [] } };
  }
  try {
    const ast = parse(input);
    return { success: true, ast };
  } catch (err) {
    if (err instanceof DslParseError) {
      return { success: false, error: { message: err.message, pos: err.pos } };
    }
    return { success: false, error: { message: `Unexpected parser failure: ${err.message}`, pos: -1 } };
  }
}

module.exports = { tokenize, parse, parseSafe, parseArgList, DslParseError };

})();
