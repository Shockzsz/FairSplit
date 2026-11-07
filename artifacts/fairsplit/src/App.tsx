import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter, Link } from 'wouter';
import { Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { answerSplitQuestion, isValidSolanaSignature } from '@/lib/expense-assistant';
import {
  ArrowLeftRight, ArrowRight, Banknote, BookOpen, Bot, CircleHelp, CirclePlus, Compass,
  ExternalLink, Home, Info, Lightbulb, LoaderCircle, LockKeyhole, Menu, Plus, Settings2,
  ShieldCheck, Sparkles, Trash2, Users, Wallet, X, Zap,
} from 'lucide-react';

type Member = { id: string; name: string; wallet?: string };
type Expense = { id: string; description: string; amountCents: number; payerId: string; participantIds: string[]; category: string; timestamp: string };
type Settlement = { id: string; senderId: string; recipientId: string; usdCreditCents: number; solLamports: number; signature: string; confirmedAt: string };
type Group = { id: string; name: string; members: Member[]; expenses: Expense[]; settlements: Settlement[]; demo?: boolean; createdAt: string };
type WalletProvider = { isPhantom?: boolean; publicKey?: PublicKey; connect: () => Promise<{ publicKey: PublicKey }>; disconnect: () => Promise<void>; signTransaction: (tx: Transaction) => Promise<Transaction> };
declare global { interface Window { solana?: WalletProvider } }
const queryClient = new QueryClient();
const STORAGE_KEY = 'fairsplit.v1.groups';
const demoNow = Date.now();
const starter: Group[] = [{
  id: 'starter-demo', name: 'Weekend in Lisbon', demo: true, createdAt: new Date(demoNow).toISOString(),
  members: [
    { id: 'member-you', name: 'You' },
    { id: 'member-maya', name: 'Maya Chen' },
    { id: 'member-jordan', name: 'Jordan Lee' },
    { id: 'member-sam', name: 'Sam Patel' },
  ],
  expenses: [
    { id: 'demo-groceries', description: 'Market groceries', amountCents: 8140, payerId: 'member-you', participantIds: ['member-you', 'member-maya', 'member-jordan', 'member-sam'], category: 'Food', timestamp: new Date(demoNow - 2 * 60 * 60 * 1000).toISOString() },
    { id: 'demo-train', description: 'Airport train tickets', amountCents: 5360, payerId: 'member-maya', participantIds: ['member-you', 'member-maya', 'member-jordan'], category: 'Travel', timestamp: new Date(demoNow - 5 * 60 * 60 * 1000).toISOString() },
    { id: 'demo-dinner', description: 'Group dinner', amountCents: 9250, payerId: 'member-jordan', participantIds: ['member-you', 'member-maya', 'member-jordan', 'member-sam'], category: 'Food', timestamp: new Date(demoNow - 9 * 60 * 60 * 1000).toISOString() },
  ],
  settlements: [],
}];
const navItems = [
  { href: '/', label: 'Overview', icon: Home },
  { href: '/groups', label: 'Groups & wallets', icon: Users },
  { href: '/assistant', label: 'Expense assistant', icon: Sparkles },
  { href: '/why-fairsplit', label: 'Why FairSplit', icon: BookOpen },
];
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const shortKey = (key: string) => `${key.slice(0, 5)}…${key.slice(-5)}`;
function loadGroups(): Group[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Group[];
      if (Array.isArray(parsed)) {
        const untouchedLegacyStarter = parsed.length === 1
          && parsed[0].id === 'starter-demo'
          && parsed[0].demo === true
          && parsed[0].expenses.length === 0
          && parsed[0].settlements.length === 0
          && parsed[0].members.length === 2
          && parsed[0].members[0].id === 'member-you'
          && parsed[0].members[1].id === 'member-friend';
        return untouchedLegacyStarter ? starter : parsed;
      }
    }
  } catch { /* recover with a clean local demo */ }
  return starter;
}
function equalShares(cents: number, people: string[]) {
  if (!people.length) return [];
  const base = Math.floor(cents / people.length), remainder = cents % people.length;
  return people.map((memberId, index) => ({ memberId, cents: base + (index < remainder ? 1 : 0) }));
}
function getBalances(group: Group) {
  const totals = new Map(group.members.map(m => [m.id, 0]));
  for (const expense of group.expenses) {
    totals.set(expense.payerId, (totals.get(expense.payerId) ?? 0) + expense.amountCents);
    for (const share of equalShares(expense.amountCents, expense.participantIds)) totals.set(share.memberId, (totals.get(share.memberId) ?? 0) - share.cents);
  }
  for (const settlement of group.settlements) {
    totals.set(settlement.senderId, (totals.get(settlement.senderId) ?? 0) + settlement.usdCreditCents);
    totals.set(settlement.recipientId, (totals.get(settlement.recipientId) ?? 0) - settlement.usdCreditCents);
  }
  return totals;
}
function suggestSettlements(group: Group) {
  const balances = [...getBalances(group)].map(([id, cents]) => ({ id, cents })).filter(item => item.cents !== 0);
  const debtors = balances.filter(x => x.cents < 0).map(x => ({ ...x })).sort((a,b) => a.cents - b.cents);
  const creditors = balances.filter(x => x.cents > 0).map(x => ({ ...x })).sort((a,b) => b.cents - a.cents);
  const result: { senderId: string; recipientId: string; cents: number }[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const cents = Math.min(-debtors[i].cents, creditors[j].cents);
    if (cents > 0) result.push({ senderId: debtors[i].id, recipientId: creditors[j].id, cents });
    debtors[i].cents += cents; creditors[j].cents -= cents;
    if (debtors[i].cents === 0) i++;
    if (creditors[j].cents === 0) j++;
  }
  return result;
}
function initials(name: string) { return name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(); }

function App() {
  const [groups, setGroups] = useState<Group[]>(loadGroups);
  const [activeGroupId, setActiveGroupId] = useState(() => loadGroups()[0]?.id ?? 'starter-demo');
  const [path] = useLocation();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [airdropBusy, setAirdropBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<'group' | 'member' | 'expense' | 'edit-group' | 'edit-member' | 'review' | null>(null);
  const [editingId, setEditingId] = useState('');
  const [editingMemberId, setEditingMemberId] = useState('');
  const [reviewDraft, setReviewDraft] = useState<{ senderId: string; recipientId: string; cents: number } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const pending = useRef(false);
  const connection = useMemo(() => new Connection('https://api.devnet.solana.com', 'confirmed'), []);
  const activeGroup = groups.find(g => g.id === activeGroupId) ?? groups[0];
  const allExpenses = groups.flatMap(g => g.expenses.map(e => ({ ...e, groupName: g.name, groupId: g.id }))).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  const totalSpent = allExpenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  const memberBalance = activeGroup ? getBalances(activeGroup) : new Map<string, number>();
  const suggestions = activeGroup ? suggestSettlements(activeGroup) : [];

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(groups)); }, [groups]);
  useEffect(() => { if (activeGroup && !groups.some(g => g.id === activeGroupId)) setActiveGroupId(activeGroup.id); }, [activeGroup, activeGroupId, groups]);
  useEffect(() => { document.title = `${navItems.find(n => n.href === path)?.label ?? 'FairSplit'} · FairSplit`; }, [path]);
  useEffect(() => { if (walletAddress) refreshBalance(walletAddress); }, [walletAddress]);

  function updateGroup(groupId: string, mutate: (group: Group) => Group) {
    setGroups(current => current.map(group => group.id === groupId ? mutate(group) : group));
  }
  async function connectWallet() {
    setWalletError('');
    if (!window.solana?.isPhantom) { setWalletError('Phantom was not found. Install the Phantom browser extension, then reconnect.'); return; }
    setWalletBusy(true);
    try { const response = await window.solana.connect(); setWalletAddress(response.publicKey.toBase58()); }
    catch (error) { setWalletError(error instanceof Error ? error.message : 'Wallet connection was cancelled.'); }
    finally { setWalletBusy(false); }
  }
  async function disconnectWallet() {
    try { await window.solana?.disconnect(); } finally { setWalletAddress(null); setSolBalance(null); }
  }
  async function refreshBalance(address = walletAddress) {
    if (!address) return;
    try { const balance = await connection.getBalance(new PublicKey(address), 'confirmed'); setSolBalance(Number(balance) / LAMPORTS_PER_SOL); }
    catch { setWalletError('Could not load the Devnet balance. Check your connection and try again.'); }
  }
  async function explainTransaction(signature: string) {
    const cleanSignature = signature.trim();
    if (!cleanSignature) throw new Error('Paste a Solana transaction signature first.');
    if (!isValidSolanaSignature(cleanSignature)) {
      throw new Error('That is not a valid Solana transaction signature. Use the Base58 signature copied from a Devnet transaction.');
    }
    const transaction = await connection.getParsedTransaction(cleanSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction) throw new Error('No confirmed transaction with that signature was found on Devnet.');
    const fee = transaction.meta?.fee ?? 0;
    const feeSol = (Number(fee) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') || '0';
    if (transaction.meta?.err) {
      return `This transaction was included on Devnet, but it failed. The network fee was ${feeSol} SOL. A failed transaction is not a successful payment, even though it has a public signature. Check its details in Solana Explorer before updating any records.`;
    }
    const transferInstruction = transaction.transaction.message.instructions.find(instruction => {
      if (!('parsed' in instruction) || instruction.program !== 'system' || !instruction.parsed || typeof instruction.parsed !== 'object') return false;
      return (instruction.parsed as { type?: string }).type === 'transfer';
    });
    if ('parsed' in (transferInstruction ?? {})) {
      const parsed = (transferInstruction as { parsed: { info?: { source?: string; destination?: string; lamports?: number } } }).parsed;
      const info = parsed.info;
      if (info?.source && info.destination && Number.isFinite(Number(info.lamports))) {
        const amount = (Number(info.lamports) / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') || '0';
        return `This confirmed Devnet transaction sent ${amount} SOL from ${shortKey(info.source)} to ${shortKey(info.destination)}. The network fee was ${feeSol} SOL. The signature is the public receipt; it confirms what happened on-chain, but it does not establish a USD exchange rate or prove that a separate expense ledger was correct.`;
      }
    }
    return `This transaction is confirmed on Devnet. It used ${transaction.transaction.message.instructions.length} instruction(s), and its network fee was ${feeSol} SOL. The signature identifies the public record. This lookup could not find a basic SOL transfer to summarize, so review the full instruction details in Solana Explorer.`;
  }
  async function requestAirdrop() {
    if (!walletAddress || airdropBusy) return;
    setAirdropBusy(true); setWalletError('');
    try {
      const signature = await connection.requestAirdrop(new PublicKey(walletAddress), LAMPORTS_PER_SOL);
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) throw new Error('The Devnet faucet transaction did not confirm successfully.');
      await refreshBalance(); setNotice('Devnet airdrop confirmed. It has no cash value.');
    } catch (error) { setWalletError(error instanceof Error ? error.message : 'Airdrop unavailable. Devnet faucet limits may apply.'); }
    finally { setAirdropBusy(false); }
  }
  function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim(); if (!name) return;
    const group: Group = { id: crypto.randomUUID(), name, members: [], expenses: [], settlements: [], createdAt: new Date().toISOString() };
    setGroups(items => [group, ...items]); setActiveGroupId(group.id); setModal(null); setNotice(`“${name}” is ready for your group.`);
  }
  function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!activeGroup) return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (name) updateGroup(activeGroup.id, group => ({ ...group, name }));
    setModal(null); setNotice('Group details updated.');
  }
  function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!activeGroup) return;
    const form = new FormData(event.currentTarget), name = String(form.get('name') ?? '').trim(), wallet = String(form.get('wallet') ?? '').trim();
    if (!name) return;
    if (wallet) { try { new PublicKey(wallet); } catch { setWalletError('That wallet address is not a valid Solana public key.'); return; } }
    updateGroup(activeGroup.id, group => ({ ...group, members: [...group.members, { id: crypto.randomUUID(), name, ...(wallet ? { wallet } : {}) }] }));
    setModal(null); setWalletError(''); setNotice(`${name} added to ${activeGroup.name}.`);
  }
  function editMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!activeGroup) return;
    const form = new FormData(event.currentTarget), name = String(form.get('name') ?? '').trim(), wallet = String(form.get('wallet') ?? '').trim();
    if (!name) return;
    if (wallet) { try { new PublicKey(wallet); } catch { setWalletError('That wallet address is not a valid Solana public key.'); return; } }
    updateGroup(activeGroup.id, group => ({ ...group, members: group.members.map(m => m.id === editingMemberId ? { ...m, name, ...(wallet ? { wallet } : { wallet: undefined }) } : m) }));
    setModal(null); setWalletError(''); setNotice('Member details updated.');
  }
  function deleteMember(id: string) {
    if (!activeGroup) return;
    const member = activeGroup.members.find(m => m.id === id);
    if (!member || !window.confirm(`Remove ${member.name}? This is only allowed when they have no expenses or confirmed settlements.`)) return;
    const used = activeGroup.expenses.some(e => e.payerId === id || e.participantIds.includes(id)) || activeGroup.settlements.some(s => s.senderId === id || s.recipientId === id);
    if (used) { setNotice('This member has expense history. Remove or resolve that activity before deleting them.'); return; }
    updateGroup(activeGroup.id, group => ({ ...group, members: group.members.filter(m => m.id !== id) }));
  }
  function addExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!activeGroup) return;
    const form = new FormData(event.currentTarget);
    const description = String(form.get('description') ?? '').trim(), amount = Number(form.get('amount')), payerId = String(form.get('payer') ?? ''), category = String(form.get('category') ?? 'Other');
    const participantIds = form.getAll('participants').map(String);
    if (!description || !Number.isFinite(amount) || amount <= 0 || participantIds.length === 0 || !activeGroup.members.some(m => m.id === payerId)) return;
    const expense: Expense = { id: crypto.randomUUID(), description, amountCents: Math.round(amount * 100), payerId, participantIds, category, timestamp: new Date().toISOString() };
    updateGroup(activeGroup.id, group => ({ ...group, expenses: [expense, ...group.expenses] }));
    setModal(null); setNotice('Expense added. Shares use exact-cent rounding.');
  }
  function deleteExpense(groupId: string, expenseId: string) {
    if (!window.confirm('Remove this expense? Group balances will be recalculated.')) return;
    updateGroup(groupId, group => ({ ...group, expenses: group.expenses.filter(e => e.id !== expenseId) }));
  }
  function deleteGroup(groupId: string) {
    const group = groups.find(item => item.id === groupId);
    if (!group || !window.confirm(`Delete “${group.name}” and all its locally stored expense and settlement records? Confirmed blockchain transfers cannot be reversed.`)) return;
    setGroups(current => current.filter(item => item.id !== groupId));
    if (activeGroupId === groupId) setActiveGroupId(groups.find(item => item.id !== groupId)?.id ?? '');
    setNotice('Group and its local records removed. Any confirmed chain transfers remain on Devnet.');
  }
  function launchSettlement(item: { senderId: string; recipientId: string; cents: number }) {
    const debtor = activeGroup?.members.find(m => m.id === item.senderId);
    if (!activeGroup || !debtor) return;
    if (!walletAddress) { setWalletError('Connect Phantom before starting a payment.'); return; }
    if (!debtor.wallet || debtor.wallet !== walletAddress) {
      setWalletError(`Connect the wallet assigned to ${debtor.name}, or update their wallet on Groups & wallets. Payments require the sender's own Phantom approval.`); return;
    }
    setReviewDraft(item); setModal('review');
  }
  async function confirmPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeGroup || !reviewDraft || pending.current) return;
    const form = new FormData(event.currentTarget);
    const sol = Number(form.get('sol')), usdCredit = Number(form.get('credit'));
    const recipient = activeGroup.members.find(m => m.id === reviewDraft.recipientId);
    if (!walletAddress || !recipient?.wallet || !Number.isFinite(sol) || sol <= 0 || !Number.isFinite(usdCredit) || usdCredit <= 0) {
      setWalletError('Enter valid SOL and USD credit amounts, and make sure the recipient has a wallet address.'); return;
    }
    const duplicateWindow = Date.now() - 10 * 60 * 1000;
    const matchingRecent = activeGroup.settlements.find(item => item.senderId === reviewDraft.senderId && item.recipientId === reviewDraft.recipientId && item.usdCreditCents === Math.round(usdCredit * 100) && new Date(item.confirmedAt).getTime() >= duplicateWindow);
    if (matchingRecent && !window.confirm('A matching settlement was confirmed within the last 10 minutes. Start another identical payment anyway?')) return;
    let destination: PublicKey;
    try { destination = new PublicKey(recipient.wallet); } catch { setWalletError('The recipient wallet address is invalid.'); return; }
    if (recipient.wallet === walletAddress) { setWalletError('The destination is the connected wallet. Choose the other member’s wallet.'); return; }
    pending.current = true; setWalletBusy(true); setWalletError('');
    try {
      const provider = window.solana;
      if (!provider?.isPhantom || !provider.publicKey || provider.publicKey.toBase58() !== walletAddress) throw new Error('Reconnect the expected Phantom wallet before approving this payment.');
      const lamports = Math.round(sol * LAMPORTS_PER_SOL);
      if (lamports <= 0) throw new Error('SOL amount is below the smallest transferable unit.');
      const latest = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: new PublicKey(walletAddress), recentBlockhash: latest.blockhash }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(walletAddress), toPubkey: destination, lamports }));
      const signed = await provider.signTransaction(tx);
      const signature = await connection.sendRawTransaction(await signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
      const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (confirmation.value.err) throw new Error('The network did not confirm this transfer successfully. No settlement credit was recorded.');
      const settlement: Settlement = { id: crypto.randomUUID(), senderId: reviewDraft.senderId, recipientId: reviewDraft.recipientId, usdCreditCents: Math.round(usdCredit * 100), solLamports: lamports, signature, confirmedAt: new Date().toISOString() };
      setGroups(current => current.map(group => group.id === activeGroup.id
        ? { ...group, settlements: group.settlements.some(item => item.signature === signature) ? group.settlements : [settlement, ...group.settlements] }
        : group));
      setNotice('Transfer confirmed on Devnet. The USD balance credit was saved separately.'); setModal(null); setReviewDraft(null); await refreshBalance();
    } catch (error) { setWalletError(error instanceof Error ? error.message : 'Transfer failed or was cancelled. No settlement credit was recorded.'); }
    finally { pending.current = false; setWalletBusy(false); }
  }

  const activeLabel = navItems.find(item => item.href === path)?.label ?? 'Overview';
  return (
    <div className="shell grain flex bg-[#f8f7fc] text-[#28243a]">
      {mobileNav && <button aria-label="Close menu" onClick={() => setMobileNav(false)} className="fixed inset-0 z-30 bg-[#211c35]/30 md:hidden" />}
      <aside className={`sidebar fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-[#e8e4f0] px-5 py-6 transition-transform md:translate-x-0 ${mobileNav ? 'translate-x-0' : '-translate-x-full'} md:sticky md:top-0 md:h-screen`}>
        <Link href="/" className="mb-10 flex items-center gap-3 px-1" onClick={() => setMobileNav(false)}>
          <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#7258d3] text-white shadow-[0_8px_18px_#7258d333]"><ArrowLeftRight size={21} strokeWidth={2.4} /></span>
          <span><span className="display block text-[20px] font-extrabold leading-none">FairSplit</span><span className="mt-1 block text-[10px] font-bold uppercase tracking-[.16em] text-[#858098]">money, made fair</span></span>
        </Link>
        <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[.16em] text-[#9893a8]">Workspace</div>
        <nav aria-label="Main navigation" className="space-y-1">
          {navItems.map(item => {
            const Icon = item.icon, active = path === item.href;
            return <Link key={item.href} href={item.href} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`} onClick={() => setMobileNav(false)} className={`nav-link flex items-center gap-3 rounded-xl px-3 py-3 text-[13px] font-semibold ${active ? 'bg-white text-[#674fc4] shadow-[0_3px_12px_#40366b0d]' : 'text-[#77738a] hover:bg-white/70 hover:text-[#38334b]'}`}><Icon size={17} />{item.label}{active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#8069dc]" />}</Link>;
          })}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="rounded-2xl border border-[#e6e1f0] bg-white/75 p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold text-[#4c4560]"><ShieldCheck size={15} className="text-[#44a887]" />Devnet only</div>
            <p className="mt-2 text-[11px] leading-relaxed text-[#89849a]">Real transfers need Phantom approval. Shared expenses stay on this device.</p>
          </div>
          <div className="flex items-center justify-between px-1 text-[10px] text-[#9691a5]"><span>FairSplit · Devnet</span><span className="mono">v1.0</span></div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-[#ebe8f1] bg-[#fbfaff]/90 px-5 backdrop-blur-md sm:px-8 lg:px-12">
          <div className="flex items-center gap-3">
            <button aria-label="Open navigation" onClick={() => setMobileNav(true)} className="rounded-lg p-2 text-[#746e87] hover:bg-[#f0edf8] md:hidden"><Menu size={20} /></button>
            <span className="text-[12px] font-medium text-[#9893a8]">FairSplit <span className="mx-1.5 text-[#c9c4d4]">/</span></span><span className="text-[12px] font-semibold text-[#39344c]">{activeLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            {walletAddress ? <div className="flex items-center gap-2 rounded-xl border border-[#e9e5f0] bg-white px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-[#54b28e]" /><span className="mono hidden text-[11px] sm:inline">{shortKey(walletAddress)}</span><span className="hidden text-[10px] text-[#9993a7] sm:inline">{solBalance === null ? '…' : `${solBalance.toFixed(3)} SOL`}</span>
              <button onClick={disconnectWallet} aria-label="Disconnect Phantom" className="ml-1 text-[10px] font-bold text-[#817a93] hover:text-[#6650bd]">Disconnect</button>
            </div> : <button onClick={connectWallet} disabled={walletBusy} className="flex items-center gap-2 rounded-xl bg-[#7158d1] px-3.5 py-2.5 text-[11px] font-bold text-white shadow-[0_5px_12px_#7258d326] hover:bg-[#6349c3] disabled:opacity-60"><Wallet size={14} />{walletBusy ? 'Connecting…' : 'Connect Phantom'}</button>}
          </div>
        </header>
        {(walletError || notice) && <div role="status" className={`mx-5 mt-4 flex items-start justify-between gap-3 rounded-xl px-4 py-3 text-[12px] sm:mx-8 lg:mx-12 ${walletError ? 'border border-[#f3cfcb] bg-[#fff4f2] text-[#9b4137]' : 'border border-[#cdeadd] bg-[#f1fbf6] text-[#2b7258]'}`}><span>{walletError || notice}</span><button aria-label="Dismiss message" onClick={() => { setWalletError(''); setNotice(''); }}><X size={15} /></button></div>}
        <div className="mx-auto max-w-[1350px] px-5 py-8 sm:px-8 lg:px-12">
          <Switch>
            <Route path="/"><Dashboard groups={groups} activeGroup={activeGroup} setActiveGroup={setActiveGroupId} totalSpent={totalSpent} balances={memberBalance} suggestions={suggestions} allExpenses={allExpenses} onAddExpense={() => setModal('expense')} onCreateGroup={() => setModal('group')} onRemoveExpense={deleteExpense} onPay={launchSettlement} /></Route>
            <Route path="/groups"><GroupsPage groups={groups} activeGroup={activeGroup} setActiveGroup={setActiveGroupId} balances={memberBalance} onCreate={() => setModal('group')} onDeleteGroup={deleteGroup} onAddMember={() => setModal('member')} onEditGroup={() => setModal('edit-group')} onEditMember={id => { setEditingMemberId(id); setModal('edit-member'); }} onDeleteMember={deleteMember} onAirdrop={requestAirdrop} airdropBusy={airdropBusy} walletAddress={walletAddress} /></Route>
            <Route path="/assistant"><AssistantPage groups={groups} activeGroup={activeGroup} balances={memberBalance} suggestions={suggestions} onExplainTransaction={explainTransaction} onAddExpenseSuggestion={suggestion => { if (!activeGroup) return; updateGroup(activeGroup.id, group => ({ ...group, expenses: [{ ...suggestion, id: crypto.randomUUID(), timestamp: new Date().toISOString() }, ...group.expenses] })); setNotice('Assistant suggestion added as a local expense.'); }} onPay={launchSettlement} /></Route>
            <Route path="/why-fairsplit"><WhyPage /></Route>
            <Route component={NotFound} />
          </Switch>
        </div>
      </main>
      {modal && activeGroup && <Modal title={modal === 'group' ? 'Start a group' : modal === 'member' ? 'Add a member' : modal === 'expense' ? 'Add an expense' : modal === 'edit-group' ? 'Edit group' : modal === 'edit-member' ? 'Edit member' : 'Review Devnet transfer'} error={walletError} onClose={() => { setModal(null); setWalletError(''); }}>
        {modal === 'group' && <form onSubmit={createGroup}><Field label="Group name"><input name="name" required autoFocus placeholder="e.g. House on Willow" maxLength={48} /></Field><p className="mb-4 text-[11px] text-[#8b8699]">New groups start with no members or expenses. Add friends and costs when you’re ready.</p><FormActions onCancel={() => setModal(null)} submit="Create group" /></form>}
        {modal === 'edit-group' && <form onSubmit={saveGroup}><Field label="Group name"><input name="name" required defaultValue={activeGroup.name} maxLength={48} /></Field><FormActions onCancel={() => setModal(null)} submit="Save changes" /></form>}
        {modal === 'member' && <MemberForm onSubmit={addMember} onCancel={() => setModal(null)} />}
        {modal === 'edit-member' && <MemberForm member={activeGroup.members.find(m => m.id === editingMemberId)} onSubmit={editMember} onCancel={() => setModal(null)} />}
        {modal === 'expense' && <ExpenseForm group={activeGroup} onSubmit={addExpense} onCancel={() => setModal(null)} />}
        {modal === 'review' && reviewDraft && <PaymentReview group={activeGroup} draft={reviewDraft} walletAddress={walletAddress} onSubmit={confirmPayment} busy={walletBusy} onCancel={() => setModal(null)} />}
      </Modal>}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="mb-4 block"><span className="mb-1.5 block text-[11px] font-bold text-[#58536a]">{label}</span>{children}{hint && <span className="mt-1.5 block text-[10px] leading-relaxed text-[#918c9f]">{hint}</span>}</label>;
}
function FormActions({ onCancel, submit, disabled = false }: { onCancel: () => void; submit: string; disabled?: boolean }) {
  return <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onCancel} className="rounded-xl px-4 py-2.5 text-[12px] font-semibold text-[#777188] hover:bg-[#f5f3f9]">Cancel</button><button disabled={disabled} className="rounded-xl bg-[#7158d1] px-4 py-2.5 text-[12px] font-bold text-white hover:bg-[#6249c1] disabled:opacity-50">{submit}</button></div>;
}
function Modal({ title, children, error, onClose }: { title: string; children: ReactNode; error: string; onClose: () => void }) {
  return <div className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-[#211c35]/35 p-4 backdrop-blur-[3px]" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="modal-title" className="fade-in my-auto w-full max-w-[490px] rounded-[24px] border border-[#ebe7f3] bg-white p-6 shadow-[0_25px_80px_#27203d33] sm:p-7"><div className="mb-6 flex items-start justify-between"><div><div className="mb-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#8874d5]">FairSplit workspace</div><h2 id="modal-title" className="display text-[24px] font-bold">{title}</h2></div><button aria-label="Close dialog" onClick={onClose} className="rounded-lg p-2 text-[#8a849b] hover:bg-[#f5f3f9]"><X size={18} /></button></div>{error && <div role="alert" className="mb-4 rounded-xl border border-[#f3cfcb] bg-[#fff4f2] px-3 py-2.5 text-[10px] leading-relaxed text-[#9b4137]">{error}</div>}{children}</section></div>;
}
function MemberForm({ member, onSubmit, onCancel }: { member?: Member; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  return <form onSubmit={onSubmit}><Field label="Name"><input name="name" required autoFocus defaultValue={member?.name} placeholder="Their name" maxLength={48} /></Field><Field label="Solana wallet address (optional)" hint="Only needed when they are the payer or recipient of an on-chain Devnet transfer. Never enter a seed phrase or private key."><input name="wallet" defaultValue={member?.wallet ?? ''} placeholder="Paste a public address" className="mono" autoComplete="off" /></Field><FormActions onCancel={onCancel} submit={member ? 'Save member' : 'Add member'} /></form>;
}
function ExpenseForm({ group, onSubmit, onCancel }: { group: Group; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<string[]>(group.members.map(m => m.id));
  return <form onSubmit={onSubmit}>
    <Field label="What was it?"><input name="description" required autoFocus placeholder="Groceries for Sunday dinner" maxLength={90} /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="Amount (USD)"><input name="amount" type="number" required min="0.01" max="1000000" step="0.01" placeholder="0.00" /></Field><Field label="Category"><select name="category" defaultValue="Food"><option>Food</option><option>Travel</option><option>Home</option><option>Utilities</option><option>Entertainment</option><option>Other</option></select></Field></div>
    <Field label="Paid by"><select name="payer" required defaultValue={group.members[0]?.id}><option value="" disabled>Choose member</option>{group.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
    <fieldset className="mb-3"><legend className="mb-2 text-[11px] font-bold text-[#58536a]">Split between</legend><div className="grid max-h-36 grid-cols-2 gap-2 overflow-auto">{group.members.map(m => <label key={m.id} className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[11px] ${selected.includes(m.id) ? 'border-[#c9bff0] bg-[#f7f5fe] text-[#51418d]' : 'border-[#ebe8f1] text-[#888397]'}`}><input name="participants" type="checkbox" value={m.id} checked={selected.includes(m.id)} onChange={e => setSelected(current => e.target.checked ? [...current, m.id] : current.filter(id => id !== m.id))} className="accent-[#7158d1]" />{m.name}</label>)}</div>{selected.length === 0 && <p className="mt-2 text-[10px] text-[#b54b44]">Select at least one person.</p>}</fieldset>
    <p className="mb-4 rounded-xl bg-[#f7f5fb] px-3 py-2.5 text-[10px] leading-relaxed text-[#858095]">Equal shares use integer cents. Extra cents are distributed one at a time in member selection order.</p>
    <FormActions onCancel={onCancel} submit="Save expense" disabled={selected.length === 0 || group.members.length === 0} />
  </form>;
}
function PaymentReview({ group, draft, walletAddress, onSubmit, busy, onCancel }: { group: Group; draft: { senderId: string; recipientId: string; cents: number }; walletAddress: string | null; onSubmit: (e: FormEvent<HTMLFormElement>) => void; busy: boolean; onCancel: () => void }) {
  const sender = group.members.find(m => m.id === draft.senderId), recipient = group.members.find(m => m.id === draft.recipientId);
  return <form onSubmit={onSubmit}>
    <div className="mb-5 rounded-2xl bg-[#f6f4fc] p-4"><div className="mb-3 flex items-center justify-between"><span className="text-[11px] font-bold text-[#5b556c]">Transfer destination</span><span className="rounded-full bg-[#eeebf8] px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-[#7158d1]">Solana Devnet</span></div><div className="text-[13px] font-bold">{recipient?.name ?? 'Recipient'}</div><div className="mono mt-1 break-all text-[10px] leading-relaxed text-[#777188]">{recipient?.wallet ?? 'No public wallet address added'}</div><div className="mt-3 border-t border-[#e7e2f1] pt-3 text-[10px] text-[#8c8799]">From {sender?.name ?? 'sender'} · {walletAddress ? shortKey(walletAddress) : 'not connected'}</div></div>
    <div className="grid grid-cols-2 gap-3"><Field label="SOL to send" hint="This exact amount is sent on-chain."><input name="sol" type="number" required min="0.000000001" step="0.000000001" placeholder="0.01" /></Field><Field label="USD balance credit" hint="You enter this separately."><input name="credit" type="number" required min="0.01" step="0.01" defaultValue={(draft.cents / 100).toFixed(2)} /></Field></div>
    <div className="mb-4 rounded-xl border border-[#f0dfb3] bg-[#fffaf0] p-3 text-[10px] leading-relaxed text-[#77633b]"><strong>No price oracle links these amounts.</strong> USD credit is a group ledger entry you choose, not a conversion from SOL. Devnet SOL is for testing and has no cash value.</div>
    <div className="mb-4 flex items-start gap-2 text-[10px] leading-relaxed text-[#777188]"><LockKeyhole size={14} className="mt-0.5 shrink-0 text-[#7158d1]" />Phantom will show the real transaction for your approval. FairSplit records the settlement only after Devnet RPC confirms it.</div>
    <FormActions onCancel={onCancel} submit={busy ? 'Waiting for confirmation…' : 'Continue to Phantom'} disabled={busy || !recipient?.wallet} />
  </form>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><div className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#7964cd]">{eyebrow}</div><h1 className="display text-[34px] font-extrabold leading-[1.05] tracking-[-.05em] text-[#2e2941] sm:text-[42px]">{title}</h1><p className="mt-2 max-w-[550px] text-[13px] leading-relaxed text-[#868196]">{description}</p></div>{action}</div>;
}
function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[20px] border border-[#ebe8f2] bg-white shadow-[0_4px_14px_#37305106] ${className}`}>{children}</section>;
}
function Dashboard({ groups, activeGroup, setActiveGroup, totalSpent, balances, suggestions, allExpenses, onAddExpense, onCreateGroup, onRemoveExpense, onPay }: { groups: Group[]; activeGroup?: Group; setActiveGroup: (id: string) => void; totalSpent: number; balances: Map<string, number>; suggestions: ReturnType<typeof suggestSettlements>; allExpenses: (Expense & { groupName: string; groupId: string })[]; onAddExpense: () => void; onCreateGroup: () => void; onRemoveExpense: (groupId: string, id: string) => void; onPay: (item: { senderId: string; recipientId: string; cents: number }) => void }) {
  const netTotal = [...balances.values()].reduce((s, v) => s + Math.max(v, 0), 0);
  return <div className="fade-in">
    <PageHeading eyebrow="Your money, in the open" title="Good to see you." description="Every shared cost, clearly accounted for. On-chain payments stay in your hands." action={<button onClick={onAddExpense} disabled={!activeGroup?.members.length} className="flex items-center justify-center gap-2 rounded-xl bg-[#7158d1] px-4 py-3 text-[12px] font-bold text-white shadow-[0_6px_15px_#7258d32b] hover:bg-[#6047bf] disabled:cursor-not-allowed disabled:opacity-50"><Plus size={16} />Add expense</button>} />
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      <Metric label="Total shared spend" value={usd(totalSpent)} icon={<Banknote size={17} />} note="Across all your groups" tint="lavender" />
      <Metric label="Your group balances" value={activeGroup ? (netTotal ? usd(netTotal) : '$0.00') : '$0.00'} icon={<ArrowLeftRight size={17} />} note={netTotal ? 'Open balances to settle' : 'No open balances right now'} tint="mint" />
      <Metric label="Groups" value={String(groups.length).padStart(2, '0')} icon={<Users size={17} />} note={`${groups.reduce((n,g) => n + g.members.length, 0)} people in your circles`} tint="peach" />
    </div>
    <div className="mb-6 flex flex-col gap-5 xl:grid xl:grid-cols-[1fr_360px]">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[#f0edf5] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="display text-[18px] font-bold">Group balance</h2><p className="mt-1 text-[10px] text-[#928da0]">A clear view of who’s owed and who owes.</p></div>
          <select aria-label="Choose group" value={activeGroup?.id ?? ''} onChange={e => setActiveGroup(e.target.value)} className="max-w-[220px] rounded-lg border border-[#e9e5f0] bg-[#fbfaff] px-3 py-2 text-[11px] font-semibold text-[#555067]">{groups.map(g => <option key={g.id} value={g.id}>{g.name}{g.demo ? ' · demo' : ''}</option>)}</select>
        </div>
        {activeGroup?.demo && <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-[#e6e0f7] bg-[#f7f5ff] p-3 text-[10px] leading-relaxed text-[#6e6394]"><Info size={14} className="mt-0.5 shrink-0" /><span><strong>Starter demo group.</strong> These expenses are illustrative examples; there are no wallet addresses or fabricated transactions. Create a new group for your own records.</span></div>}
        {!activeGroup || activeGroup.members.length === 0 ? <EmptyState title="Add your people first" copy="Your group needs members before expenses or balances can be tracked." action={<button onClick={onCreateGroup} className="text-[11px] font-bold text-[#7158d1]">Create a group</button>} /> : <div className="divide-y divide-[#f2eff6]">
          {activeGroup.members.map((member, i) => {
            const value = balances.get(member.id) ?? 0;
            return <div key={member.id} data-testid={`row-balance-${member.id}`} className="flex items-center gap-3 px-5 py-3.5"><Avatar name={member.name} index={i} /><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-bold text-[#403b52]">{member.name}</div><div className="mt-0.5 text-[10px] text-[#9893a5]">{member.wallet ? `Wallet ${shortKey(member.wallet)}` : 'No wallet connected'}</div></div><div className="text-right"><div className={`mono text-[13px] font-medium ${value > 0 ? 'text-[#31876b]' : value < 0 ? 'text-[#b85e53]' : 'text-[#9590a2]'}`}>{value > 0 ? '+' : ''}{usd(value)}</div><div className="mt-0.5 text-[9px] text-[#a09bab]">{value > 0 ? 'is owed' : value < 0 ? 'owes' : 'all square'}</div></div></div>;
          })}
        </div>}
        {activeGroup && suggestions.length > 0 && <div className="border-t border-[#f0edf5] px-5 py-4"><div className="mb-3 flex items-center gap-2 text-[11px] font-bold text-[#524b65]"><ArrowLeftRight size={14} className="text-[#7662cb]" />Fair settlement suggestions</div><div className="space-y-2">{suggestions.map((item, i) => { const from = activeGroup.members.find(m => m.id === item.senderId), to = activeGroup.members.find(m => m.id === item.recipientId); return <div key={i} className="flex items-center justify-between gap-3 rounded-xl bg-[#f8f7fb] px-3 py-2.5"><div className="min-w-0 text-[11px] text-[#686277]"><strong className="text-[#433e54]">{from?.name}</strong><span className="mx-1.5 text-[#aaa5b6]">pays</span><strong className="text-[#433e54]">{to?.name}</strong><span className="ml-1.5 text-[#aaa5b6]">{usd(item.cents)}</span></div><button onClick={() => onPay(item)} className="shrink-0 rounded-lg bg-[#eae6f8] px-3 py-1.5 text-[10px] font-bold text-[#6550bc] hover:bg-[#ddd6f3]">Review</button></div>; })}</div></div>}
      </Card>
      <Card className="p-5">
        <div className="mb-4 flex items-start justify-between"><div><h2 className="display text-[18px] font-bold">Recent expenses</h2><p className="mt-1 text-[10px] text-[#928da0]">The latest costs in your circles.</p></div><span className="rounded-lg bg-[#f3f0fb] px-2 py-1 text-[10px] font-bold text-[#7964cb]">{allExpenses.length} total</span></div>
        {allExpenses.length === 0 ? <EmptyState compact title="No expenses yet" copy="Add a shared cost to see everyone’s exact share." action={<button onClick={onAddExpense} disabled={!activeGroup?.members.length} className="mt-1 text-[10px] font-bold text-[#7158d1] disabled:opacity-50">Add your first expense</button>} /> : <div className="space-y-1">{allExpenses.slice(0, 5).map(expense => { const group = groups.find(g => g.id === expense.groupId); const payer = group?.members.find(m => m.id === expense.payerId); return <div key={expense.id} className="group flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-[#faf9fc]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#f0eef8] text-[#7864c8]"><Banknote size={16} /></span><div className="min-w-0 flex-1"><div className="truncate text-[11px] font-bold text-[#484358]">{expense.description}</div><div className="mt-0.5 truncate text-[9px] text-[#9691a3]">{payer?.name ?? 'Member'} · {expense.groupName} · {expense.category}</div></div><div className="mono text-[11px] font-medium text-[#454055]">{usd(expense.amountCents)}</div><button onClick={() => onRemoveExpense(expense.groupId, expense.id)} aria-label={`Remove ${expense.description}`} className="ml-1 text-[#c1bdcb] opacity-0 hover:text-[#bc5b51] group-hover:opacity-100 focus:opacity-100"><Trash2 size={14} /></button></div>; })}</div>}
        {allExpenses.length > 0 && <Link href="/groups" className="mt-3 flex items-center justify-between border-t border-[#f0edf5] pt-4 text-[10px] font-bold text-[#7964cb]">Manage groups and expenses <ArrowRight size={14} /></Link>}
      </Card>
    </div>
    <div className="grid gap-4 md:grid-cols-[1.1fr_.9fr]">
      <div className="relative overflow-hidden rounded-[20px] bg-[#31274e] p-5 text-white sm:p-6"><div className="absolute -right-8 -top-16 h-48 w-48 rounded-full border border-white/10" /><div className="absolute -right-1 -top-9 h-36 w-36 rounded-full border border-white/10" /><div className="relative flex items-start gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-[#d9d0ff]"><ShieldCheck size={18} /></span><div><div className="text-[12px] font-bold">Your money doesn’t move without you.</div><p className="mt-1 max-w-[480px] text-[10px] leading-relaxed text-[#cbc5dc]">Shared expense records stay in your browser. Solana Devnet transfers are separate, wallet-approved, and never treated as a USD conversion.</p></div></div></div>
      <div className="flex items-center gap-4 rounded-[20px] border border-[#ebe8f2] bg-white p-5"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f0eef9] text-[#765fca]"><Sparkles size={18} /></div><div className="min-w-0 flex-1"><div className="text-[12px] font-bold text-[#464156]">Need help with a shared cost?</div><div className="mt-1 text-[10px] text-[#928da0]">Describe it in plain language. FairSplit’s local rules suggest a draft.</div></div><Link href="/assistant" className="rounded-lg bg-[#f2effb] px-3 py-2 text-[10px] font-bold text-[#6b55c1]">Ask</Link></div>
    </div>
  </div>;
}
function Metric({ label, value, icon, note, tint }: { label: string; value: string; icon: ReactNode; note: string; tint: string }) {
  const colors: Record<string,string> = { lavender: 'bg-[#f0edfb] text-[#735bc7]', mint: 'bg-[#e7f6ef] text-[#348b6b]', peach: 'bg-[#fff1e7] text-[#be7952]' };
  return <Card className="relative overflow-hidden px-5 py-4"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[.12em] text-[#918b9f]">{label}</span><span className={`grid h-8 w-8 place-items-center rounded-xl ${colors[tint]}`}>{icon}</span></div><div className="display mt-4 text-[29px] font-extrabold tracking-[-.06em] text-[#343047]">{value}</div><div className="mt-1 text-[10px] text-[#9a95a7]">{note}</div></Card>;
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  const shades = ['bg-[#ebe6fb] text-[#6c53c5]', 'bg-[#e6f5ef] text-[#3d886c]', 'bg-[#fff0e6] text-[#b8744f]', 'bg-[#faeaf1] text-[#ad5f80]'];
  return <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[10px] font-extrabold ${shades[index % shades.length]}`}>{initials(name)}</span>;
}
function EmptyState({ title, copy, action, compact = false }: { title: string; copy: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`flex flex-col items-center justify-center px-6 text-center ${compact ? 'py-9' : 'py-10'}`}><span className="mb-3 grid h-10 w-10 place-items-center rounded-[14px] bg-[#f2eff9] text-[#8776cd]"><CirclePlus size={18} /></span><div className="text-[12px] font-bold text-[#504b61]">{title}</div><p className="mt-1 max-w-[250px] text-[10px] leading-relaxed text-[#9792a4]">{copy}</p>{action && <div className="mt-3">{action}</div>}</div>;
}

function GroupsPage({ groups, activeGroup, setActiveGroup, balances, onCreate, onDeleteGroup, onAddMember, onEditGroup, onEditMember, onDeleteMember, onAirdrop, airdropBusy, walletAddress }: { groups: Group[]; activeGroup?: Group; setActiveGroup: (id: string) => void; balances: Map<string, number>; onCreate: () => void; onDeleteGroup: (id: string) => void; onAddMember: () => void; onEditGroup: () => void; onEditMember: (id: string) => void; onDeleteMember: (id: string) => void; onAirdrop: () => void; airdropBusy: boolean; walletAddress: string | null }) {
  const [selectedGroup, setSelectedGroup] = useState('');
  const current = groups.find(g => g.id === selectedGroup) ?? activeGroup;
  return <div className="fade-in">
    <PageHeading eyebrow="People & payments" title="Groups, together." description="Organize your circle, connect public wallet addresses, and make each shared cost easier to follow." action={<button onClick={onCreate} className="flex items-center justify-center gap-2 rounded-xl bg-[#7158d1] px-4 py-3 text-[12px] font-bold text-white hover:bg-[#6047bf]"><Plus size={16} />New group</button>} />
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <Card className="h-fit p-4">
        <div className="mb-3 flex items-center justify-between px-1"><span className="text-[10px] font-bold uppercase tracking-[.14em] text-[#918b9f]">Your groups</span><span className="mono text-[10px] text-[#a39daf]">{groups.length}</span></div>
        <div className="space-y-1">{groups.map((group, i) => <button key={group.id} onClick={() => { setSelectedGroup(group.id); setActiveGroup(group.id); }} className={`flex w-full items-center gap-3 rounded-xl p-3 text-left ${current?.id === group.id ? 'bg-[#f3f0fb]' : 'hover:bg-[#faf9fc]'}`}><span className={`grid h-9 w-9 place-items-center rounded-xl text-[11px] font-extrabold ${['bg-[#eae5fa] text-[#7058c5]','bg-[#e5f4ee] text-[#438b70]','bg-[#fff0e6] text-[#b77750]'][i % 3]}`}>{initials(group.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-bold text-[#4c465d]">{group.name}</span><span className="mt-0.5 block text-[9px] text-[#9993a5]">{group.members.length} members {group.demo ? '· starter demo' : ''}</span></span>{current?.id === group.id && <span className="h-1.5 w-1.5 rounded-full bg-[#7a62d0]" />}</button>)}</div>
        <button onClick={onCreate} className="mt-3 flex w-full items-center gap-2 rounded-xl border border-dashed border-[#dcd6ed] px-3 py-3 text-[11px] font-semibold text-[#7665bb] hover:bg-[#faf9ff]"><Plus size={14} />Create another group</button>
      </Card>
      {!current ? <Card><EmptyState title="Start with a group" copy="Create a group to manage members, wallet addresses, and shared costs." action={<button onClick={onCreate} className="text-[11px] font-bold text-[#7158d1]">Create your first group</button>} /></Card> : <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-[#f0edf5] bg-gradient-to-r from-[#f8f6ff] to-white p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3"><span className="grid h-12 w-12 place-items-center rounded-[16px] bg-[#e9e4fa] text-[#7158d1]"><Users size={21} /></span><div><div className="flex items-center gap-2"><h2 className="display text-[22px] font-bold">{current.name}</h2>{current.demo && <span className="rounded-full bg-[#ede8fa] px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-[#7561c1]">Demo</span>}</div><p className="mt-1 text-[10px] text-[#928da0]">{current.members.length} members · {current.expenses.length} expenses · local-only group data</p></div></div>
            <div className="flex gap-2 self-start sm:self-center"><button onClick={onEditGroup} className="flex items-center gap-2 rounded-lg border border-[#e6e1ef] bg-white px-3 py-2 text-[10px] font-bold text-[#716b82] hover:text-[#6851c1]"><Settings2 size={13} />Edit group</button><button onClick={() => onDeleteGroup(current.id)} className="flex items-center gap-2 rounded-lg border border-[#f0dbd8] bg-white px-3 py-2 text-[10px] font-bold text-[#a95a51] hover:bg-[#fff6f4]"><Trash2 size={13} />Delete</button></div>
          </div>
          {current.demo && <div className="mx-5 mt-4 rounded-xl border border-[#e6e0f7] bg-[#f7f5ff] px-3 py-2.5 text-[10px] leading-relaxed text-[#766b99]"><strong>Starter demo only:</strong> the expenses are examples to help explore the math. There are no wallet addresses or pretend chain activity.</div>}
          <div className="flex items-center justify-between px-5 py-4"><div><h3 className="text-[12px] font-bold text-[#504b61]">Members</h3><p className="mt-1 text-[9px] text-[#9792a4]">Public wallet addresses are optional. Never ask for secret keys.</p></div><button onClick={onAddMember} className="flex items-center gap-1.5 rounded-lg bg-[#f0edfa] px-3 py-2 text-[10px] font-bold text-[#6c56c1]"><Plus size={13} />Add member</button></div>
          {current.members.length === 0 ? <EmptyState compact title="Your group is waiting" copy="Add the people you share expenses with." action={<button onClick={onAddMember} className="text-[10px] font-bold text-[#7158d1]">Add a member</button>} /> : <div className="divide-y divide-[#f2eff6]">
            {current.members.map((member, i) => <div key={member.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5"><Avatar name={member.name} index={i} /><div className="min-w-[110px] flex-1"><div className="text-[11px] font-bold text-[#49445a]">{member.name}</div><div className="mono mt-1 text-[9px] text-[#948fa2]">{member.wallet ?? 'No public wallet address'}</div></div><div className="hidden min-w-[90px] text-right sm:block"><div className={`mono text-[11px] font-medium ${(balances.get(member.id) ?? 0) > 0 ? 'text-[#32866a]' : (balances.get(member.id) ?? 0) < 0 ? 'text-[#b75b52]' : 'text-[#9893a5]'}`}>{usd(balances.get(member.id) ?? 0)}</div><div className="text-[9px] text-[#a09bab]">current balance</div></div><button onClick={() => onEditMember(member.id)} aria-label={`Edit ${member.name}`} className="rounded-lg p-2 text-[#928da0] hover:bg-[#f3f0fa] hover:text-[#7158d1]"><Settings2 size={15} /></button><button onClick={() => onDeleteMember(member.id)} aria-label={`Remove ${member.name}`} className="rounded-lg p-2 text-[#aaa5b3] hover:bg-[#fff1ef] hover:text-[#b6584d]"><Trash2 size={15} /></button></div>)}
          </div>}
        </Card>
        <div className="grid gap-5 md:grid-cols-2">
          <Card className="p-5"><div className="mb-4 flex items-start justify-between"><div><div className="text-[10px] font-bold uppercase tracking-[.13em] text-[#8470ce]">Wallet management</div><h3 className="display mt-1 text-[18px] font-bold">Devnet wallet</h3></div><Wallet size={17} className="text-[#7660cc]" /></div>
            {!walletAddress ? <div><p className="mb-4 text-[11px] leading-relaxed text-[#878295]">Connect Phantom to see your balance or request test SOL from the Devnet faucet.</p><p className="rounded-xl bg-[#f7f5fb] p-3 text-[10px] leading-relaxed text-[#8d879d]">Only public addresses are stored on member profiles. Secret recovery phrases and private keys should never be shared.</p></div> : <div><div className="rounded-xl bg-[#f7f5fb] p-3"><div className="text-[9px] font-bold uppercase tracking-wider text-[#9993a6]">Connected wallet</div><div className="mono mt-2 break-all text-[10px] text-[#4c465e]">{walletAddress}</div></div><button disabled={airdropBusy} onClick={onAirdrop} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[#e7e2f0] px-3 py-2.5 text-[10px] font-bold text-[#6954bf] hover:bg-[#faf9fd] disabled:opacity-60">{airdropBusy ? <LoaderCircle size={14} className="animate-spin" /> : <Zap size={14} />}{airdropBusy ? 'Requesting Devnet SOL…' : 'Request 1 SOL airdrop'}</button><div className="mt-2 text-center text-[9px] text-[#a09bac]">Test tokens only · Devnet faucet limits may apply</div></div>}
          </Card>
          <Card className="p-5"><div className="mb-3 flex items-center gap-2"><CircleHelp size={16} className="text-[#7158d1]" /><h3 className="text-[12px] font-bold text-[#4e495f]">How payments work</h3></div><ol className="space-y-3 text-[10px] leading-relaxed text-[#858094]"><li className="flex gap-2"><span className="mono text-[#7964cd]">01</span> Add a real public wallet address for each member.</li><li className="flex gap-2"><span className="mono text-[#7964cd]">02</span> Connect the sender’s Phantom wallet on this device.</li><li className="flex gap-2"><span className="mono text-[#7964cd]">03</span> Review destination, SOL amount, and your separate USD credit.</li><li className="flex gap-2"><span className="mono text-[#7964cd]">04</span> Approve in Phantom; FairSplit credits only after RPC confirmation.</li></ol></Card>
        </div>
        <Card className="mt-5 p-5">
          <div className="mb-4 flex items-center justify-between"><div><h3 className="display text-[17px] font-bold">Confirmed settlement history</h3><p className="mt-1 text-[10px] text-[#928da0]">Recorded locally only after Devnet RPC confirmation.</p></div><span className="rounded-lg bg-[#eff8f3] px-2 py-1 text-[9px] font-bold text-[#45896f]">{current.settlements.length} confirmed</span></div>
          {current.settlements.length === 0 ? <div className="rounded-xl bg-[#f8f7fb] px-4 py-5 text-center text-[10px] text-[#9691a3]">No confirmed settlement transactions yet. Suggestions are not transactions.</div> : <div className="space-y-2">{current.settlements.map(item => <div key={item.id} className="flex flex-col gap-2 rounded-xl border border-[#eeeaf3] p-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-[10px] font-bold text-[#504a61]">{current.members.find(m => m.id === item.senderId)?.name ?? 'Member'} → {current.members.find(m => m.id === item.recipientId)?.name ?? 'Member'} <span className="font-normal text-[#928da0]">· {usd(item.usdCreditCents)} ledger credit</span></div><div className="mono mt-1 text-[9px] text-[#827c90]">{(item.solLamports / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL · {new Date(item.confirmedAt).toLocaleString()}</div></div><a href={`https://explorer.solana.com/tx/${encodeURIComponent(item.signature)}?cluster=devnet`} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-[9px] font-bold text-[#6e57c5] hover:underline">{shortKey(item.signature)} <ExternalLink size={11} /></a></div>)}</div>}
        </Card>
      </div>}
    </div>
  </div>;
}

type Suggestion = Omit<Expense, 'id' | 'timestamp'>;
function classify(text: string) {
  const s = text.toLowerCase();
  if (/uber|taxi|gas|fuel|train|flight|parking|bus|ride/.test(s)) return 'Travel';
  if (/rent|soap|paper towel|furniture|house|cleaning|home/.test(s)) return 'Home';
  if (/electric|power|internet|water|utility|bill/.test(s)) return 'Utilities';
  if (/movie|concert|game|ticket|museum|bowling/.test(s)) return 'Entertainment';
  if (/pizza|lunch|dinner|coffee|grocer|food|restaurant|breakfast|snack|takeout/.test(s)) return 'Food';
  return 'Other';
}
function parseExpense(text: string, group: Group): Suggestion {
  const amountMatch = text.match(/(?:\$|usd\s*)?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/i);
  const amountCents = amountMatch ? Math.round(Number(amountMatch[1].replaceAll(',', '')) * 100) : 0;
  let description = text.trim()
    .replace(/(?:we|i)\s+(?:spent|paid|split|bought)\s+/i, '')
    .replace(/(?:cost|came to|was)\s+\$?\d[\d,.]*/i, '')
    .replace(/\$?\d[\d,.]*/g, '')
    .replace(/\b(?:for|on)\s+(?:the\s+)?/i, '')
    .replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
  description = description ? description.charAt(0).toUpperCase() + description.slice(1) : 'Shared expense';
  const byName = group.members.find(m => new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  return { description, amountCents, payerId: byName?.id ?? group.members[0]?.id ?? '', participantIds: group.members.map(m => m.id), category: classify(text) };
}
function AssistantPage({ groups, activeGroup, balances, suggestions, onExplainTransaction, onAddExpenseSuggestion, onPay }: { groups: Group[]; activeGroup?: Group; balances: Map<string, number>; suggestions: ReturnType<typeof suggestSettlements>; onExplainTransaction: (signature: string) => Promise<string>; onAddExpenseSuggestion: (suggestion: Suggestion) => void; onPay: (item: { senderId: string; recipientId: string; cents: number }) => void }) {
  const [groupId, setGroupId] = useState(activeGroup?.id ?? '');
  const group = groups.find(g => g.id === groupId) ?? activeGroup;
  const [query, setQuery] = useState('');
  const [splitQuestion, setSplitQuestion] = useState('');
  const [splitAnswer, setSplitAnswer] = useState('');
  const [result, setResult] = useState<Suggestion | null>(null);
  const [submittedText, setSubmittedText] = useState('');
  const [infoTab, setInfoTab] = useState<'concepts' | 'signatures'>('concepts');
  const [signature, setSignature] = useState('');
  const [transactionExplanation, setTransactionExplanation] = useState('');
  const [transactionError, setTransactionError] = useState('');
  const [explainingTransaction, setExplainingTransaction] = useState(false);
  const expenses = group?.expenses ?? [];
  const duplicates = result && group ? expenses.filter(e => e.description.toLowerCase() === result.description.toLowerCase() && Math.abs(e.amountCents - result.amountCents) <= 1) : [];
  const large = result ? result.amountCents >= 50000 : false;
  const currentSuggestions = group ? suggestSettlements(group) : suggestions;
  function ask(e: FormEvent) {
    e.preventDefault();
    if (!query.trim() || !group) return;
    setSubmittedText(query.trim()); setResult(parseExpense(query, group));
  }
  function askSplitQuestion(e: FormEvent) {
    e.preventDefault();
    setSplitAnswer(answerSplitQuestion(splitQuestion, group?.members ?? []));
  }
  async function explainSubmittedTransaction(e: FormEvent) {
    e.preventDefault();
    setTransactionError(''); setTransactionExplanation('');
    if (!isValidSolanaSignature(signature)) {
      setTransactionError('That is not a valid Solana transaction signature. Use the Base58 signature copied from a Devnet transaction.');
      return;
    }
    setExplainingTransaction(true);
    try { setTransactionExplanation(await onExplainTransaction(signature)); }
    catch (error) { setTransactionError(error instanceof Error ? error.message : 'Could not read that Devnet transaction.'); }
    finally { setExplainingTransaction(false); }
  }
  return <div className="fade-in">
    <PageHeading eyebrow="Expense assistant · local calculations" title="Ask about a split." description="Ask a normal question about a shared cost. FairSplit calculates the split locally without a wallet or Solana RPC; no genuine AI model is configured." />
    <div className="mb-5 flex flex-col gap-5 xl:grid xl:grid-cols-[1fr_335px]">
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <div className="flex flex-col justify-between gap-3 border-b border-[#f0edf5] bg-[#fbfaff] p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#ece7fb] text-[#755dc9]"><Bot size={19} /></span><div><div className="text-[12px] font-bold text-[#484257]">Expense AI assistant</div><div className="mt-1 text-[10px] text-[#9590a2]">Local arithmetic · no wallet · no RPC</div></div></div>
            <select aria-label="Expense assistant group" value={group?.id ?? ''} onChange={e => { setGroupId(e.target.value); setResult(null); setSplitAnswer(''); }} className="max-w-[210px] rounded-lg border border-[#e8e4ef] bg-white px-3 py-2 text-[10px] font-semibold">{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
          </div>
          <div className="p-5">
            <form onSubmit={askSplitQuestion}>
              <label htmlFor="expense-question" className="mb-2 block text-[11px] font-bold text-[#5e586f]">Ask a normal question about the split</label>
              <textarea id="expense-question" data-testid="input-expense-question" value={splitQuestion} onChange={e => setSplitQuestion(e.target.value)} rows={3} maxLength={500} placeholder="I spent £120 on dinner for four people. Sarah paid the full amount. Everyone should contribute equally." className="w-full resize-y rounded-xl border border-[#e9e5f0] bg-white p-3 text-[12px] leading-relaxed outline-none focus:border-[#b7a9e8] focus:ring-2 focus:ring-[#7158d1]/10" />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[9px] text-[#9691a3]">Uses only the question text and local group member names.</p>
                <button data-testid="button-calculate-split" disabled={!splitQuestion.trim()} className="flex items-center gap-2 rounded-xl bg-[#7158d1] px-4 py-2.5 text-[10px] font-bold text-white hover:bg-[#6047bf] disabled:opacity-50"><Sparkles size={13} />Explain the split</button>
              </div>
            </form>
            {splitAnswer && <div role="status" data-testid="text-expense-answer" className="mt-4 rounded-xl border border-[#e6e0f7] bg-[#f8f6ff] p-4 text-[11px] leading-relaxed text-[#5f5875]">{splitAnswer}<div className="mt-3 border-t border-[#e9e4f4] pt-3 text-[9px] font-semibold text-[#7968ad]">Local rules-based calculation · not genuine AI · no wallet or Solana request</div></div>}
          </div>
        </Card>
        <Card className="overflow-hidden">
          <div className="border-b border-[#f0edf5] bg-[#fbfaff] p-5"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#ece7fb] text-[#755dc9]"><Banknote size={18} /></span><div><div className="text-[12px] font-bold text-[#484257]">Draft an expense</div><div className="mt-1 text-[10px] text-[#9590a2]">Separate local tool · editable before saving to the selected group</div></div></div></div>
          <div className="p-5">
            {!group || group.members.length === 0 ? <EmptyState compact title="Add members to begin" copy="Expense suggestions need a group and at least one member." /> : <>
              <form onSubmit={ask}><label htmlFor="assistant-prompt" className="mb-2 block text-[11px] font-bold text-[#5e586f]">What did the group spend?</label><div className="flex gap-2"><input id="assistant-prompt" data-testid="input-assistant-prompt" value={query} onChange={e => setQuery(e.target.value)} placeholder="We spent $42.80 on groceries, split between everyone" className="min-w-0 flex-1" /><button className="flex shrink-0 items-center gap-2 rounded-xl bg-[#7158d1] px-4 text-[11px] font-bold text-white hover:bg-[#6047bf]"><Sparkles size={14} />Suggest</button></div></form>
              <div className="mt-3 flex flex-wrap gap-2">{['$18.50 for pizza', 'Uber ride for $26.40', 'We paid $120 for utilities'].map(text => <button key={text} onClick={() => { setQuery(text); setSubmittedText(text); setResult(parseExpense(text, group)); }} className="rounded-full border border-[#e9e5f0] px-3 py-1.5 text-[9px] font-medium text-[#807a90] hover:border-[#cfc5ef] hover:bg-[#faf9fe]">{text}</button>)}</div>
              {result && <div className="mt-5 rounded-[16px] border border-[#e8e2f5] bg-[#fcfbff] p-4">
                <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2 text-[11px] font-bold text-[#514b62]"><Lightbulb size={15} className="text-[#8069d2]" />Editable expense suggestion</div><span className="rounded-full bg-[#eeeafb] px-2.5 py-1 text-[9px] font-bold text-[#7059c4]">{result.category}</span></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Description"><input value={result.description} onChange={e => setResult({ ...result, description: e.target.value })} /></Field>
                  <Field label="Amount (USD)"><input type="number" min="0.01" step="0.01" value={(result.amountCents / 100).toFixed(2)} onChange={e => setResult({ ...result, amountCents: Math.round(Number(e.target.value) * 100) || 0 })} /></Field>
                  <Field label="Paid by"><select value={result.payerId} onChange={e => setResult({ ...result, payerId: e.target.value })}>{group.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
                  <Field label="Category"><select value={result.category} onChange={e => setResult({ ...result, category: e.target.value })}>{['Food','Travel','Home','Utilities','Entertainment','Other'].map(x => <option key={x}>{x}</option>)}</select></Field>
                </div>
                <fieldset className="mb-4"><legend className="mb-2 text-[10px] font-bold text-[#5e586f]">Who shares it?</legend><div className="flex flex-wrap gap-2">{group.members.map(member => <label key={member.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-[9px] ${result.participantIds.includes(member.id) ? 'border-[#c9bff0] bg-[#f7f5fe] text-[#51418d]' : 'border-[#ebe8f1] text-[#888397]'}`}><input data-testid={`checkbox-assistant-participant-${member.id}`} type="checkbox" checked={result.participantIds.includes(member.id)} onChange={e => setResult({ ...result, participantIds: e.target.checked ? [...result.participantIds, member.id] : result.participantIds.filter(id => id !== member.id) })} className="accent-[#7158d1]" />{member.name}</label>)}</div></fieldset>
                <div className="mb-4 rounded-xl bg-[#f5f3fa] p-3"><div className="mb-2 text-[10px] font-bold text-[#5e586f]">Equal split · {result.participantIds.length} {result.participantIds.length === 1 ? 'person' : 'people'}</div>{result.participantIds.length > 0 ? <div className="flex flex-wrap gap-2">{equalShares(result.amountCents, result.participantIds).map(share => <span key={share.memberId} className="rounded-lg bg-white px-2 py-1.5 text-[9px] text-[#6f6980]">{group.members.find(m => m.id === share.memberId)?.name} <strong className="mono ml-1 text-[#514a68]">{usd(share.cents)}</strong></span>)}</div> : <div className="text-[9px] text-[#a6574e]">Choose at least one person to split this expense.</div>}<div className="mt-2 text-[9px] text-[#9993a5]">Integer-cent remainder is assigned in the member order shown.</div></div>
                {duplicates.length > 0 && <div role="alert" className="mb-3 rounded-xl border border-[#efcfaa] bg-[#fff8ed] p-3 text-[10px] leading-relaxed text-[#8e642f]"><strong>Possible duplicate:</strong> a similar description and amount already exists in this group. Check its date before adding another.</div>}
                {large && <div role="alert" className="mb-3 rounded-xl border border-[#efcfaa] bg-[#fff8ed] p-3 text-[10px] leading-relaxed text-[#8e642f]"><strong>Unusually large expense:</strong> this rule flags amounts of $500 or more. Double-check the amount and who shares it.</div>}
                {!result.amountCents && <div className="mb-3 rounded-xl border border-[#efcfaa] bg-[#fff8ed] p-3 text-[10px] text-[#8e642f]">No amount was recognized. Enter an amount above to complete this suggestion.</div>}
                <div className="flex justify-end gap-2"><button onClick={() => setResult(null)} className="rounded-lg px-3 py-2 text-[10px] font-bold text-[#817b90]">Discard</button><button disabled={!result.amountCents || !result.description.trim() || result.participantIds.length === 0} onClick={() => { onAddExpenseSuggestion(result); setResult(null); setQuery(''); }} className="rounded-lg bg-[#7158d1] px-4 py-2 text-[10px] font-bold text-white disabled:opacity-50">Add expense to group</button></div>
                <div className="mt-3 border-t border-[#ece8f3] pt-3 text-[9px] leading-relaxed text-[#a19bab]">Parsed from: “{submittedText}” · Amount, payer, category, description, and participants can all be edited. Participants default to all group members.</div>
              </div>}
            </>}
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between"><div><h2 className="display text-[18px] font-bold">Fair settlement plan</h2><p className="mt-1 text-[10px] text-[#928da0]">Greedy matching minimizes the number of suggested transfers.</p></div><ArrowLeftRight size={16} className="text-[#7862ca]" /></div>
          {!group || currentSuggestions.length === 0 ? <div className="rounded-xl bg-[#f8f7fb] px-4 py-5 text-center text-[10px] text-[#9691a3]">No payments suggested. Add a shared cost to establish balances.</div> : <div className="space-y-2">{currentSuggestions.map((s, i) => <div key={i} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#efedf4] px-4 py-3"><div className="flex items-center gap-2 text-[11px] text-[#716b80]"><span className="font-bold text-[#4e485f]">{group?.members.find(m => m.id === s.senderId)?.name}</span><ArrowRight size={13} /><span className="font-bold text-[#4e485f]">{group?.members.find(m => m.id === s.recipientId)?.name}</span></div><div className="flex items-center gap-3"><span className="mono text-[12px] font-bold text-[#504a61]">{usd(s.cents)}</span><button onClick={() => onPay(s)} className="rounded-lg bg-[#f0edfa] px-3 py-1.5 text-[9px] font-bold text-[#6d57c0]">Review payment</button></div></div>)}</div>}
          <p className="mt-3 text-[9px] leading-relaxed text-[#a09bac]">Suggestions are about shared USD ledger balances. Sending Devnet SOL is optional and requires an independent wallet transaction.</p>
        </Card>
      </div>
      <aside className="space-y-5">
        <Card className="overflow-hidden"><div className="border-b border-[#f0edf5] p-4"><div className="flex items-center gap-2 text-[11px] font-bold text-[#504b61]"><BookOpen size={15} className="text-[#7660ca]" />Learn as you go</div><p className="mt-1 text-[9px] text-[#9792a4]">Plain-English blockchain notes</p></div><div className="flex gap-1 border-b border-[#f0edf5] px-4 pt-3"><button onClick={() => setInfoTab('concepts')} className={`rounded-t-lg px-3 py-2 text-[9px] font-bold ${infoTab === 'concepts' ? 'bg-[#f2effa] text-[#6d56c2]' : 'text-[#918b9f]'}`}>Concepts</button><button onClick={() => setInfoTab('signatures')} className={`rounded-t-lg px-3 py-2 text-[9px] font-bold ${infoTab === 'signatures' ? 'bg-[#f2effa] text-[#6d56c2]' : 'text-[#918b9f]'}`}>Signatures</button></div>
          {infoTab === 'concepts' ? <div className="space-y-4 p-4"><Concept title="What is Devnet?" text="A public Solana test network. Its SOL is for testing and has no cash value. FairSplit sends transactions only to this network." /><Concept title="Why Phantom approval?" text="Your wallet holds the authority to sign. FairSplit prepares a transfer, but Phantom shows it to you before anything can be sent." /><Concept title="What stays local?" text="Groups, expense records, and confirmed settlement notes live in this browser’s localStorage. They are not uploaded to FairSplit servers." /></div> : <div className="p-4"><div className="rounded-xl bg-[#f7f5fb] p-3 text-[10px] leading-relaxed text-[#817b90]">A transaction signature is a unique identifier for a signed transaction. After Devnet confirms it, anyone can inspect its public record in a Devnet explorer. It proves the chain transaction; it does not prove a USD conversion.</div><a href="https://explorer.solana.com/?cluster=devnet" target="_blank" rel="noreferrer" className="mt-3 flex items-center gap-2 text-[10px] font-bold text-[#7158d1]">Open Solana Devnet Explorer <ExternalLink size={12} /></a></div>}
        </Card>
        <Card className="p-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold text-[#504b61]"><BookOpen size={15} className="text-[#7660ca]" />Solana transaction explainer</div>
          <p className="mb-4 text-[10px] leading-relaxed text-[#928da0]">Devnet signatures only. Ordinary questions belong in the Expense AI assistant and are never sent to Solana RPC.</p>
          <form onSubmit={explainSubmittedTransaction} className="flex flex-col gap-2 sm:flex-row">
            <input data-testid="input-transaction-signature" value={signature} onChange={e => setSignature(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste a Solana transaction signature" className="mono min-w-0 flex-1" aria-label="Solana transaction signature" />
            <button data-testid="button-explain-transaction" disabled={explainingTransaction || !signature.trim()} className="flex items-center justify-center gap-2 rounded-xl bg-[#7158d1] px-4 py-2.5 text-[10px] font-bold text-white hover:bg-[#6047bf] disabled:opacity-50">{explainingTransaction ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />}{explainingTransaction ? 'Looking up…' : 'Explain'}</button>
          </form>
          {transactionError && <p role="alert" data-testid="status-transaction-explanation-error" className="mt-3 rounded-xl border border-[#f3cfcb] bg-[#fff4f2] p-3 text-[10px] leading-relaxed text-[#9b4137]">{transactionError}</p>}
          {transactionExplanation && <p role="status" data-testid="text-transaction-explanation" className="mt-3 rounded-xl border border-[#e6e0f7] bg-[#f8f6ff] p-3 text-[10px] leading-relaxed text-[#645d78]">{transactionExplanation}</p>}
        </Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-[11px] font-bold text-[#524c62]"><Info size={14} className="text-[#8a76d2]" />What this helper does</div><p className="mt-2 text-[10px] leading-relaxed text-[#8d879b]">It extracts a number, recognizes a few everyday spending categories, and spots exact-ish repeats. Rules are visible and deterministic; no prompt leaves your browser and no AI model is running.</p><div className="mt-3 rounded-lg bg-[#f4f1fa] px-3 py-2 text-[9px] font-semibold text-[#7869a9]">Local rules-based assistant · not generative AI</div></Card>
      </aside>
    </div>
  </div>;
}
function Concept({ title, text }: { title: string; text: string }) {
  return <div><div className="mb-1 text-[10px] font-bold text-[#514b62]">{title}</div><p className="text-[9px] leading-relaxed text-[#8d879a]">{text}</p></div>;
}

function WhyPage() {
  return <div className="fade-in">
    <div className="relative mb-7 overflow-hidden rounded-[26px] bg-[#30274b] px-6 py-9 text-white sm:px-10 sm:py-12">
      <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full border border-white/10" /><div className="absolute -right-8 -top-12 h-48 w-48 rounded-full border border-white/10" /><div className="absolute right-16 top-10 h-20 w-20 rounded-full border border-[#a897ed]/30" />
      <div className="relative max-w-[720px]"><div className="mb-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#c5b8ff]"><Compass size={14} /> The FairSplit thesis</div><h1 className="display max-w-[680px] text-[38px] font-extrabold leading-[1.02] tracking-[-.055em] sm:text-[56px]">Trust should be part of the split.</h1><p className="mt-5 max-w-[560px] text-[13px] leading-relaxed text-[#d4cee4]">FairSplit makes the quiet math of living together visible—and keeps a real payment under the sender’s control.</p></div>
    </div>
    <div className="grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
      <Card className="p-6 sm:p-7"><div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#806ad0]"><CircleHelp size={14} />The problem</div><h2 className="display text-[24px] font-extrabold leading-tight text-[#353047]">Shared costs get awkward when the math gets invisible.</h2><p className="mt-4 text-[12px] leading-[1.85] text-[#777286]">A group buys groceries, splits a ride, or covers a bill. Someone pays now; someone else means to pay them back later. The trouble isn’t arithmetic alone—it’s remembering who joined which expense, seeing how a balance formed, and knowing whether “paid” means a real transfer happened.</p><div className="mt-5 space-y-3">{['Splits need to be explainable, not just a final number.', 'A suggested settlement is not the same as money sent.', 'Wallet approval should stay with the person paying.'].map((text, i) => <div key={text} className="flex items-start gap-3 text-[11px] text-[#666176]"><span className="mono mt-0.5 text-[10px] text-[#927fdb]">0{i + 1}</span>{text}</div>)}</div></Card>
      <Card className="p-6 sm:p-7"><div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#4d9b7d]"><ShieldCheck size={14} />How FairSplit responds</div><div className="space-y-5">
        <StoryRow icon={<Users size={17} />} title="A shared ledger, not a mystery total" text="Members, expenses, participants, and equal shares form a transparent local record. Cent remainders are assigned in a visible, deterministic order." />
        <StoryRow icon={<Wallet size={17} />} title="Solana Devnet, with clear boundaries" text="A real SOL transfer is prepared for Devnet and requires the sender’s Phantom signature. The app waits for RPC confirmation before recording a settlement." />
        <StoryRow icon={<Bot size={17} />} title="A helper that says what it is" text="Everyday text gets parsed with local rules: amount recognition, category hints, duplicate checks, and settlement recommendations. There is no paid AI provider and no generative model." />
      </div></Card>
    </div>
    <div className="my-5 grid gap-5 md:grid-cols-[1.1fr_.9fr]">
      <Card className="p-6 sm:p-7"><div className="mb-3 text-[10px] font-bold uppercase tracking-[.15em] text-[#806ad0]">The boundary is the feature</div><h2 className="display text-[23px] font-extrabold">Two amounts. Two different meanings.</h2><p className="mt-3 text-[11px] leading-[1.8] text-[#7e788d]">A settlement pairs an on-chain SOL transfer with a user-entered USD credit to the group ledger. There is no price oracle connecting them. The user reviews both values, Phantom approves the transaction, and only a confirmed signature can trigger the ledger credit. Devnet SOL has no cash value.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-[#f3f0fb] p-4"><div className="mono text-[9px] font-medium uppercase tracking-wider text-[#8271c9]">On-chain · Devnet</div><div className="mt-2 text-[12px] font-bold text-[#4b455d]">SOL + transaction signature</div><div className="mt-1 text-[9px] leading-relaxed text-[#928ca1]">Public network record, confirmed by RPC.</div></div><div className="rounded-xl bg-[#eef8f3] p-4"><div className="mono text-[9px] font-medium uppercase tracking-wider text-[#42886e]">Local ledger</div><div className="mt-2 text-[12px] font-bold text-[#4b455d]">USD balance credit</div><div className="mt-1 text-[9px] leading-relaxed text-[#928ca1]">A separate amount the user enters.</div></div></div></Card>
      <Card className="flex flex-col justify-between bg-[#faf9fd] p-6 sm:p-7"><div><div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#806ad0]"><Sparkles size={14} />What makes it different</div><h2 className="display text-[23px] font-extrabold">Honest by design.</h2><div className="mt-4 space-y-3 text-[11px] leading-relaxed text-[#777286]"><p><strong className="text-[#4d475f]">No invented chain history.</strong> The starter group has clearly marked example expenses, but no fabricated wallets or signatures.</p><p><strong className="text-[#4d475f]">No key custody.</strong> Public addresses only. Phantom holds and signs with the user’s keys.</p><p><strong className="text-[#4d475f]">No server-side ledger.</strong> Group information persists in browser localStorage only.</p><p><strong className="text-[#4d475f]">No pretend AI.</strong> The assistant is a small, inspectable local rules engine.</p></div></div><Link href="/" className="mt-6 flex items-center justify-between rounded-xl bg-[#7158d1] px-4 py-3 text-[11px] font-bold text-white hover:bg-[#6047bf]">Back to your dashboard <ArrowRight size={15} /></Link></Card>
    </div>
    <div className="mb-5 rounded-[20px] border border-[#e9e5f0] bg-white px-5 py-4 text-[10px] leading-relaxed text-[#8a8497]"><strong className="text-[#5f596e]">Demo note:</strong> This app targets Solana Devnet only. Test SOL is not real money. Wallet transactions incur network fees and are irreversible once confirmed. Verify every destination and amount in Phantom before signing.</div>
  </div>;
}
function StoryRow({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="flex gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#f0edfa] text-[#765fca]">{icon}</span><div><div className="text-[11px] font-bold text-[#504b61]">{title}</div><p className="mt-1 text-[10px] leading-relaxed text-[#8b8599]">{text}</p></div></div>;
}

function RootApp() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><ErrorBoundary><App /></ErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default RootApp;
