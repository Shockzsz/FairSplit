export type AssistantMember = { id: string; name: string };

type Currency = 'GBP' | 'USD' | 'EUR';

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

export function isValidSolanaSignature(value: string): boolean {
  const signature = value.trim();
  if (!signature || signature.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) return false;

  let decoded = 0n;
  for (const character of signature) {
    decoded = decoded * 58n + BigInt(base58Alphabet.indexOf(character));
  }

  const leadingZeroBytes = signature.match(/^1+/)?.[0].length ?? 0;
  const significantHex = decoded === 0n ? '' : decoded.toString(16);
  const significantBytes = Math.ceil(significantHex.length / 2);
  return leadingZeroBytes + significantBytes === 64;
}

function parseCount(value: string): number {
  const clean = value.toLowerCase();
  return /^\d+$/.test(clean) ? Number(clean) : (numberWords[clean] ?? 0);
}

function money(minorUnits: number, currency: Currency): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minorUnits / 100);
}

function extractAmount(text: string, countMatch: RegExpMatchArray | null): number | null {
  const amountPattern = String.raw`(\d[\d,]*(?:\.\d{1,2})?)`;
  const matched = text.match(new RegExp(String.raw`(?:£|€|\$|(?:GBP|USD|EUR)\s*)\s*${amountPattern}`, 'i'))
    ?? text.match(new RegExp(String.raw`\b${amountPattern}\s*(?:GBP|USD|EUR|pounds?|dollars?|euros?)\b`, 'i'))
    ?? text.match(new RegExp(String.raw`\b(?:spent|paid|total|bill|cost(?:s|ed)?|amount)\b[^0-9£€$]{0,24}[£€$]?\s*${amountPattern}`, 'i'));

  const raw = matched?.[1];
  if (raw) {
    const amount = Number(raw.replaceAll(',', ''));
    if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100);
  }

  const countStart = countMatch?.index === undefined
    ? -1
    : countMatch.index + countMatch[0].lastIndexOf(countMatch[1]);
  const countEnd = countStart < 0 ? -1 : countStart + (countMatch?.[1].length ?? 0);
  const otherNumber = [...text.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)]
    .find(match => match.index === undefined || match.index < countStart || match.index >= countEnd);
  if (!otherNumber) return null;
  const amount = Number(otherNumber[0].replaceAll(',', ''));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function extractPayer(text: string, members: AssistantMember[]): string | undefined {
  const paidBy = text.match(/\b(?:paid|covered|fronted)\s+by\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/iu)?.[1];
  const namedPayer = text.match(/\b([\p{Lu}][\p{L}'-]*(?:\s+[\p{Lu}][\p{L}'-]*)?)\s+(?:paid|covered|fronted)\b/iu)?.[1];
  const firstPerson = /\b(?:i|me)\s+(?:paid|spent|covered|fronted)\b/i.test(text) ? 'you' : undefined;
  const candidate = paidBy ?? namedPayer ?? firstPerson;
  if (!candidate) return undefined;
  if (/^(i|me|you)$/i.test(candidate)) return 'you';
  return members.find(member => member.name.toLowerCase() === candidate.toLowerCase())?.name ?? candidate;
}

export function answerSplitQuestion(
  question: string,
  members: AssistantMember[] = [],
): string {
  const text = question.trim();
  if (!text) return 'Ask a question with a total amount and how many people are sharing it.';

  const currency: Currency = /£|\b(?:gbp|pounds?)\b/i.test(text)
    ? 'GBP'
    : /€|\b(?:eur|euros?)\b/i.test(text)
      ? 'EUR'
      : 'USD';
  const countToken = String.raw`(?:\d{1,2}|${Object.keys(numberWords).join('|')})`;
  const countMatch = text.match(new RegExp(
    String.raw`\b(?:for|among|between|across|split(?:\s+(?:among|between|across))?|shared\s+(?:among|between))\s+(?:the\s+)?(${countToken})(?:\s+(?:people|persons|friends|of\s+us|ways))?\b`,
    'i',
  )) ?? text.match(new RegExp(String.raw`\b(${countToken})\s+(?:people|persons|friends|of\s+us|ways)\b`, 'i'));
  const mentionsEveryone = /\b(?:everyone|everybody|all of us|the whole group)\b/i.test(text);
  const participantCount = countMatch
    ? parseCount(countMatch[1])
    : mentionsEveryone ? members.length : 0;
  const totalCents = extractAmount(text, countMatch);

  if (!totalCents) {
    return 'I can calculate this locally. Include the total amount, such as “£120”, and the number of people sharing it.';
  }
  if (participantCount < 2) {
    return 'I found the amount, but need the number of people sharing it. Try “£120 split equally between four people.”';
  }
  if (participantCount > 20) {
    return 'For this local calculation, please use a group of 20 people or fewer.';
  }

  const payer = extractPayer(text, members);
  const knownPayer = payer && members.find(member => member.name.toLowerCase() === payer.toLowerCase());
  const listedMembersMatchCount = members.length === participantCount;
  const participants = listedMembersMatchCount
    ? members
    : Array.from({ length: participantCount }, (_, index) => ({ id: `person-${index}`, name: `Person ${index + 1}` }));

  let payerIndex = payer && knownPayer && listedMembersMatchCount
    ? participants.findIndex(member => member.id === knownPayer.id)
    : 0;
  if (payerIndex < 0) payerIndex = 0;

  const baseShare = Math.floor(totalCents / participantCount);
  const leftoverCents = totalCents % participantCount;
  const shares = participants.map((member, index) => ({
    member,
    cents: baseShare + (index < leftoverCents ? 1 : 0),
  }));
  const payerShare = shares[payerIndex].cents;
  const otherShares = shares.filter((_, index) => index !== payerIndex);
  const totalRepaid = otherShares.reduce((sum, share) => sum + share.cents, 0);
  const totalText = money(totalCents, currency);
  const payerText = payer === 'you' ? 'You' : payer;
  const payerPossessive = payer === 'you' ? 'your' : `${payerText}’s`;
  const debtorPhrase = participantCount === 2 ? 'The other person owes' : `The other ${participantCount - 1} people each owe`;
  const shareAmounts = [...new Set(otherShares.map(share => share.cents))];

  let answer = `${totalText} split equally among ${participantCount} people is ${money(baseShare, currency)} per person`;
  if (leftoverCents > 0) answer += `, with ${leftoverCents} extra ${leftoverCents === 1 ? 'penny' : 'pennies'} assigned in participant order`;
  answer += '.';

  if (!payer || !payerText) {
    return `${answer} If one person covered the whole bill, the others should reimburse that person for their shares. This is a local calculation, not a wallet payment.`;
  }

  if (shareAmounts.length === 1) {
    answer += ` ${payerText} paid the full amount, so ${payerPossessive} own ${money(payerShare, currency)} share is covered. ${debtorPhrase} ${payerText} ${money(otherShares[0].cents, currency)}, ${money(totalRepaid, currency)} in total.`;
  } else if (listedMembersMatchCount && knownPayer) {
    const namedShares = otherShares.map(share => `${share.member.name} owes ${payerText} ${money(share.cents, currency)}`).join('; ');
    answer += ` ${payerText} paid the full amount and covers ${payerPossessive} own ${money(payerShare, currency)} share. ${namedShares}; together they repay ${money(totalRepaid, currency)}.`;
  } else {
    const minimum = Math.min(...otherShares.map(share => share.cents));
    const maximum = Math.max(...otherShares.map(share => share.cents));
    answer += ` Assuming ${payerText} is included in the split, ${payerPossessive} own ${money(payerShare, currency)} share is covered. The other ${participantCount - 1} people owe ${payerText} between ${money(minimum, currency)} and ${money(maximum, currency)} each, ${money(totalRepaid, currency)} in total.`;
  }

  return `${answer} This answer uses local arithmetic only; no wallet or Solana RPC is needed.`;
}
