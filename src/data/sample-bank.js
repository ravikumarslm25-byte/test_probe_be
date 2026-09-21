/* ============================================================
   Sample question bank.

   One bank per subject family, keyed by the letters in the subject
   code: 19CSC201 → CSC, 19ITC304 → ITC, 19ECC202 → ECC, 19MAB102 → MAB.
   Anything else falls back to CSC. Each bank holds ten multiple-choice,
   ten fill-in-the-blank and four descriptive questions — enough to fill
   the Sathyabama 50-mark pattern exactly.

   Used by the seed, and by the builder's "Load sample paper" button so
   a coordinator can raise a complete paper in one click for a demo.
   ============================================================ */

const CSC = {
  mcq: [
    ['Which phase of the software development life cycle produces the software requirements specification?',
      ['Design', 'Requirement analysis', 'Implementation', 'Maintenance'], 'B'],
    ['In an entity relationship model, an attribute that uniquely identifies each entity instance is called a',
      ['Composite attribute', 'Derived attribute', 'Key attribute', 'Multivalued attribute'], 'C'],
    ['What is the time complexity of binary search on a sorted array of n elements?',
      ['O(n)', 'O(n log n)', 'O(log n)', 'O(1)'], 'C'],
    ['Which of the following is not a characteristic of an algorithm?',
      ['Finiteness', 'Definiteness', 'Ambiguity', 'Effectiveness'], 'C'],
    ['The process of removing redundancy from a relational database design is known as',
      ['Indexing', 'Normalisation', 'Partitioning', 'Aggregation'], 'B'],
    ['Which data structure uses the last in, first out principle?',
      ['Queue', 'Stack', 'Linked list', 'Tree'], 'B'],
    ['In object oriented programming, the ability of a single interface to represent different underlying forms is called',
      ['Encapsulation', 'Inheritance', 'Polymorphism', 'Abstraction'], 'C'],
    ['Which scheduling algorithm can cause starvation of lower priority processes?',
      ['Round robin', 'First come first served', 'Priority scheduling', 'Shortest job first'], 'C'],
    ['The transport layer protocol that provides reliable, connection oriented delivery is',
      ['UDP', 'IP', 'TCP', 'ICMP'], 'C'],
    ['A relation is in third normal form if it is in second normal form and has no',
      ['Partial dependency', 'Transitive dependency', 'Multivalued dependency', 'Join dependency'], 'B'],
  ],
  fib: [
    ['The ________ model of software development delivers the product in successive increments.', ['incremental', 'iterative']],
    ['In a relational database, a ________ key refers to the primary key of another relation.', ['foreign']],
    ['The worst case time complexity of quicksort is ________.', ['O(n^2)', 'O(n2)', 'n squared', 'quadratic']],
    ['A ________ is a sequence of database operations treated as a single logical unit of work.', ['transaction']],
    ['Hiding internal implementation while exposing only the necessary interface is called ________.', ['abstraction', 'encapsulation']],
    ['A ________ occurs when two processes each wait for a resource held by the other.', ['deadlock']],
    ['The ________ layer of the OSI model is responsible for routing packets between networks.', ['network']],
    ['A tree in which every node has at most two children is a ________ tree.', ['binary']],
    ['The ________ statement in SQL is used to retrieve rows from one or more tables.', ['select']],
    ['In C, a ________ is a variable that stores the memory address of another variable.', ['pointer']],
  ],
  desc: [
    ['Explain the waterfall and spiral models of software development. Compare them in terms of risk handling, cost of change and suitability for large projects. Support your answer with a labelled diagram of each model.',
      [['waterfall', 2], ['spiral', 2], ['risk analysis', 2], ['iteration', 1], ['sequential', 1], ['prototype', 1]]],
    ['Explain normalisation in relational database design. Take an unnormalised relation from an examination management context and normalise it step by step up to third normal form, stating the dependency removed at each stage.',
      [['first normal form', 1], ['second normal form', 1], ['third normal form', 1], ['partial dependency', 2], ['transitive dependency', 2], ['atomic', 1]]],
    ['Compare the round robin and shortest remaining time first scheduling algorithms. For four processes with given arrival and burst times, draw Gantt charts for each and compute the average waiting time.',
      [['round robin', 1], ['time quantum', 2], ['preemptive', 1], ['waiting time', 2], ['gantt chart', 1], ['starvation', 1]]],
    ['Describe the four pillars of object oriented programming. Illustrate each with a short code example and explain how they contribute to maintainable software.',
      [['encapsulation', 2], ['inheritance', 2], ['polymorphism', 2], ['abstraction', 2], ['maintainab', 1]]],
  ],
};

const ITC = {
  mcq: [
    ['Which of the following is an immutable data type in Python?', ['list', 'dict', 'tuple', 'set'], 'C'],
    ['What does the expression 7 // 2 evaluate to in Python 3?', ['3.5', '3', '4', '1'], 'B'],
    ['Which keyword defines a function in Python?', ['func', 'define', 'def', 'function'], 'C'],
    ['What is the output of len("Sathyabama")?', ['9', '10', '11', 'An error'], 'B'],
    ['Which method adds an element to the end of a list?', ['add()', 'push()', 'append()', 'insert()'], 'C'],
    ['A dictionary in Python is a collection of', ['ordered values', 'key value pairs', 'unique values', 'characters'], 'B'],
    ['Which statement is used to handle exceptions in Python?', ['catch', 'try', 'error', 'handle'], 'B'],
    ['What does the range(2, 10, 3) produce?', ['2, 5, 8', '2, 4, 6, 8', '3, 6, 9', '2, 5, 8, 10'], 'A'],
    ['Which of these opens a file for reading only?', ["open('f', 'w')", "open('f', 'a')", "open('f', 'r')", "open('f', 'x')"], 'C'],
    ['List comprehension [x*x for x in range(4)] yields', ['[0, 1, 4, 9]', '[1, 4, 9, 16]', '[0, 1, 2, 3]', '[1, 2, 3, 4]'], 'A'],
  ],
  fib: [
    ['Python uses ________ rather than braces to delimit blocks of code.', ['indentation', 'indent', 'whitespace']],
    ['The ________ function converts a string to an integer.', ['int', 'int()']],
    ['A function that calls itself is said to be ________.', ['recursive']],
    ['The ________ keyword is used to import a module.', ['import']],
    ['In Python, ________ is the value that represents the absence of a value.', ['None']],
    ['The method ________ returns a list of the keys in a dictionary.', ['keys', 'keys()']],
    ['A ________ is an anonymous function defined with a single expression.', ['lambda']],
    ['The ________ statement exits the innermost enclosing loop.', ['break']],
    ['String literals prefixed with f are called ________ strings.', ['formatted', 'f-strings', 'f strings']],
    ['The ________ operator tests whether a value is present in a sequence.', ['in']],
  ],
  desc: [
    ['Explain the difference between a list, a tuple and a dictionary in Python. For each, give an example of a situation where it is the correct choice and one where it is the wrong choice.',
      [['mutable', 2], ['immutable', 2], ['key', 1], ['ordered', 1], ['hashable', 1], ['lookup', 1]]],
    ['Write a Python function that reads a text file of examination marks, one register number and mark per line, and returns the average, the highest scorer and a list of candidates below a given threshold. Handle a missing file gracefully.',
      [['open', 1], ['with', 1], ['except', 2], ['FileNotFoundError', 2], ['split', 1], ['average', 1], ['max', 1]]],
    ['Explain exception handling in Python. Describe the try, except, else and finally blocks with an example, and explain when you would define a custom exception class.',
      [['try', 1], ['except', 1], ['finally', 2], ['else', 1], ['raise', 1], ['class', 1], ['inherit', 1]]],
    ['Describe object oriented programming in Python. Define a class for a Student with attributes and methods, demonstrate inheritance with a PostgraduateStudent subclass, and explain the role of __init__ and self.',
      [['class', 1], ['__init__', 2], ['self', 2], ['inherit', 2], ['method', 1], ['super', 1]]],
  ],
};

const ECC = {
  mcq: [
    ['The output of a two input NAND gate is 0 when', ['both inputs are 0', 'both inputs are 1', 'inputs differ', 'either input is 0'], 'B'],
    ['Which number system is the basis of digital electronics?', ['Decimal', 'Octal', 'Binary', 'Hexadecimal'], 'C'],
    ['The binary equivalent of decimal 13 is', ['1011', '1101', '1110', '1001'], 'B'],
    ['A flip flop is a', ['combinational circuit', 'sequential circuit', 'rectifier', 'amplifier'], 'B'],
    ['Which gate is called a universal gate?', ['AND', 'OR', 'NAND', 'XOR'], 'C'],
    ['A multiplexer with 8 inputs needs how many select lines?', ['2', '3', '4', '8'], 'B'],
    ['The 2s complement of binary 0101 is', ['1010', '1011', '1001', '0110'], 'B'],
    ['A decoder with n inputs has at most how many outputs?', ['n', '2n', '2 to the power n', 'n squared'], 'C'],
    ['Which flip flop has no invalid state?', ['SR', 'JK', 'D', 'Both JK and D'], 'D'],
    ['A counter that counts from 0 to 7 is a', ['mod 7 counter', 'mod 8 counter', 'ring counter', 'decade counter'], 'B'],
  ],
  fib: [
    ['A ________ map is used to simplify Boolean expressions graphically.', ['Karnaugh', 'K']],
    ['The Boolean expression A + A.B simplifies to ________.', ['A']],
    ['A ________ adder adds two single bits and a carry in.', ['full']],
    ['The hexadecimal equivalent of binary 1111 is ________.', ['F', 'f']],
    ['A ________ register stores data and shifts it one position on each clock pulse.', ['shift']],
    ['De Morgan\u2019s theorem states that the complement of a product equals the ________ of the complements.', ['sum']],
    ['A ________ circuit\u2019s output depends only on the present inputs.', ['combinational']],
    ['The ________ state of a latch is the state where the output is not defined.', ['invalid', 'forbidden', 'race']],
    ['A ________ counter changes all its flip flops simultaneously on the same clock.', ['synchronous']],
    ['BCD stands for binary coded ________.', ['decimal']],
  ],
  desc: [
    ['Design a full adder from two half adders and an OR gate. Derive the truth table, write the sum and carry expressions, and draw the final circuit.',
      [['half adder', 2], ['sum', 1], ['carry', 2], ['XOR', 2], ['truth table', 1], ['AND', 1]]],
    ['Simplify the Boolean function F(A,B,C,D) = \u03a3m(0,1,2,5,8,9,10) using a four variable Karnaugh map. Show the groupings and implement the result using only NAND gates.',
      [['karnaugh', 1], ['group', 2], ['don\u2019t care', 1], ['prime implicant', 2], ['nand', 2], ['minimise', 1]]],
    ['Compare SR, JK, D and T flip flops. For each, give the characteristic table, the excitation table and one typical application.',
      [['characteristic table', 2], ['excitation table', 2], ['toggle', 1], ['race', 1], ['edge triggered', 1], ['application', 1]]],
    ['Design a mod 10 synchronous counter using JK flip flops. Show the state diagram, the excitation table and the final circuit with the reset logic.',
      [['state diagram', 2], ['excitation', 2], ['jk', 1], ['mod 10', 1], ['reset', 2], ['decade', 1]]],
  ],
};

const MAB = {
  mcq: [
    ['The number of edges in a complete graph with 6 vertices is', ['12', '15', '30', '36'], 'B'],
    ['Which of the following is a tautology?', ['p \u2227 \u00acp', 'p \u2228 \u00acp', 'p \u2192 \u00acp', 'p \u2194 \u00acp'], 'B'],
    ['The power set of a set with n elements has how many elements?', ['n', '2n', '2 to the power n', 'n factorial'], 'C'],
    ['A relation that is reflexive, symmetric and transitive is called', ['a partial order', 'an equivalence relation', 'a function', 'a total order'], 'B'],
    ['The contrapositive of p \u2192 q is', ['q \u2192 p', '\u00acp \u2192 \u00acq', '\u00acq \u2192 \u00acp', 'p \u2194 q'], 'C'],
    ['How many ways can 3 books be chosen from 7?', ['21', '35', '42', '210'], 'B'],
    ['A graph with no cycles that is connected is a', ['forest', 'tree', 'clique', 'bipartite graph'], 'B'],
    ['The sum of the degrees of all vertices in a graph equals', ['the number of edges', 'twice the number of edges', 'the number of vertices', 'half the number of edges'], 'B'],
    ['Which of the following is not a valid inference rule?', ['Modus ponens', 'Modus tollens', 'Affirming the consequent', 'Hypothetical syllogism'], 'C'],
    ['The gcd of 48 and 18 is', ['3', '6', '9', '12'], 'B'],
  ],
  fib: [
    ['A proposition that is always false is called a ________.', ['contradiction']],
    ['A function that is both one to one and onto is called a ________.', ['bijection', 'bijective']],
    ['The ________ principle states that if n items are placed in m boxes with n > m, some box holds more than one item.', ['pigeonhole']],
    ['A graph in which every pair of distinct vertices is adjacent is called ________.', ['complete']],
    ['The ________ of a set A with respect to a universal set U is U minus A.', ['complement']],
    ['A path that visits every vertex exactly once is a ________ path.', ['Hamiltonian', 'Hamilton']],
    ['The number of permutations of n distinct objects is ________.', ['n!', 'n factorial']],
    ['Two integers are ________ if their greatest common divisor is 1.', ['coprime', 'relatively prime']],
    ['A ________ is a relation that is reflexive, antisymmetric and transitive.', ['partial order', 'poset']],
    ['The ________ of a graph is the minimum number of colours needed to colour its vertices with no adjacent vertices sharing a colour.', ['chromatic number']],
  ],
  desc: [
    ['State and prove the principle of mathematical induction. Use it to prove that the sum of the first n odd numbers is n squared.',
      [['base case', 2], ['inductive', 2], ['hypothesis', 1], ['n squared', 1], ['k + 1', 2], ['assume', 1]]],
    ['Define an equivalence relation and prove that the relation "a \u2261 b (mod 5)" on the integers is an equivalence relation. Describe its equivalence classes.',
      [['reflexive', 2], ['symmetric', 2], ['transitive', 2], ['equivalence class', 2], ['modulo', 1]]],
    ['Explain Euler and Hamiltonian paths and circuits. State the conditions under which a connected graph has an Euler circuit, and apply them to the K\u00f6nigsberg bridge problem.',
      [['euler', 1], ['hamiltonian', 1], ['degree', 2], ['even', 2], ['k\u00f6nigsberg', 1], ['connected', 1]]],
    ['Solve the recurrence relation a(n) = 5a(n\u22121) \u2212 6a(n\u22122) with a(0) = 1 and a(1) = 4. Show the characteristic equation, its roots and the closed form.',
      [['characteristic equation', 2], ['roots', 2], ['closed form', 2], ['initial condition', 1], ['linear', 1]]],
  ],
};

const BANKS = { CSC, ITC, ECC, MAB };

/* 19CSC201 → CSC. Falls back to CSC when the letters are unknown. */
export function bankFor(subjectCode = '') {
  const letters = String(subjectCode).replace(/[^A-Za-z]/g, '').toUpperCase();
  return BANKS[letters] || BANKS[letters.slice(0, 3)] || CSC;
}

/* Rows shaped for bulk upload, sized to a blueprint. Cycles through the
   bank if the blueprint asks for more than it holds, appending a suffix
   so no two questions are identical. */
export function samplePaper(subjectCode, blueprint) {
  const bank = bankFor(subjectCode);
  const rows = [];

  for (const section of blueprint.sections) {
    const source = section.type === 'mcq' ? bank.mcq
      : section.type === 'fib' ? bank.fib
      : bank.desc;

    for (let i = 0; i < section.count; i++) {
      const item = source[i % source.length];
      const cycle = Math.floor(i / source.length);
      const suffix = cycle ? ` (variant ${cycle + 1})` : '';

      if (section.type === 'mcq') {
        const [text, options, correct] = item;
        rows.push({
          section: section.key, type: 'mcq', marks: section.marksEach,
          text: text + suffix,
          options: options.map((o, j) => ({ key: 'ABCD'[j], text: o })),
          correctOptions: [correct],
        });
      } else if (section.type === 'fib') {
        const [text, accepted] = item;
        rows.push({
          section: section.key, type: 'fib', marks: section.marksEach,
          text: text + suffix, acceptedAnswers: accepted,
        });
      } else {
        const [text, keywords] = item;
        rows.push({
          section: section.key, type: 'desc', marks: section.marksEach,
          text: text + suffix,
          keywords: keywords.map(([term, weight]) => ({ term, weight })),
          markingGuidance: 'Award marks for each concept covered with a correct explanation. Full marks require all named concepts plus a coherent argument or worked example.',
        });
      }
    }
  }
  return rows;
}

export const SUBJECT_FAMILIES = Object.keys(BANKS);
