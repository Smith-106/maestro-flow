// Reproduce the synthetic ONNX compatibility fixture without Python or downloads.
// This is NOT a trained BERT: its BERT-shaped output is float(input_ids) + 0.5,
// expanded to [batch, sequence, 1]. It tests real native execution, not quality.
import { writeFileSync } from 'node:fs';

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(bytes);
}
const message = (...parts) => Buffer.concat(parts);
const integer = (field, value) => message(varint(field * 8), varint(value));
const bytes = (field, value) => {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return message(varint(field * 8 + 2), varint(data.length), data);
};
const dimension = value => bytes(1, typeof value === 'string' ? bytes(2, value) : integer(1, value));
const valueInfo = (name, type, dims) => message(
  bytes(1, name),
  bytes(2, bytes(1, message(integer(1, type), bytes(2, message(...dims.map(dimension)))))),
);
const attribute = (name, value) => message(bytes(1, name), integer(3, value), integer(20, 2));
const node = (op, inputs, output, attrs = []) => message(
  ...inputs.map(input => bytes(1, input)), bytes(2, output), bytes(4, op),
  ...attrs.map(attr => bytes(5, attr)),
);
const bias = Buffer.alloc(4);
bias.writeFloatLE(0.5);
const graph = message(
  bytes(1, node('Cast', ['input_ids'], 'floats', [attribute('to', 1)])),
  bytes(1, node('Add', ['floats', 'bias'], 'shifted')),
  bytes(1, node('Unsqueeze', ['shifted'], 'last_hidden_state', [
    message(bytes(1, 'axes'), integer(8, 2), integer(20, 7)),
  ])),
  bytes(2, 'tiny-bert-shaped-cpu-fixture'),
  bytes(5, message(integer(1, 1), integer(2, 1), bytes(8, 'bias'), bytes(9, bias))),
  bytes(11, valueInfo('input_ids', 7, ['batch', 'sequence'])),
  bytes(12, valueInfo('last_hidden_state', 1, ['batch', 'sequence', 1])),
);
const model = message(integer(1, 8), bytes(2, 'maestro-flow-fixture'), bytes(7, graph), bytes(8, integer(2, 11)));
writeFileSync(new URL('./onnx/model.onnx', import.meta.url), model);
console.log(`Generated ${model.length}-byte ONNX IR 8/opset 11 CPU fixture`);
