import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { ApiError, api, centsFromInput, dateTime, money } from './api';
import { AuthProvider, useAuth, type User } from './auth';

type State = 'scheduled' | 'live' | 'closed' | 'cancelled';
type Bid = { id: string; sequence: number; amountCents: number; createdAt: string; bidderPublicId: string };
type Item = { id: number; title: string; description: string; category: string; brand: string | null; price: number; rating: number | null; stock: number | null; tags: string[]; images: string[]; thumbnail: string; warrantyInformation?: string };
type Lot = {
  id: string; title: string; description: string; imageUrl: string; item: Item; status: State;
  startsAt: string; endsAt: string; sellerPublicId: string; sellerName?: string; startingCents: number;
  incrementCents: number; currentBidCents: number | null; winnerPublicId?: string | null; receiptToken?: string | null; userHasBid?: boolean; bids?: Bid[];
};

function categoryLabel(category?: string) {
  if (!category) return 'Seleção da casa';
  const labels: Record<string, string> = {
    audio: 'Áudio',
    'mobile-accessories': 'Acessórios para celular',
    furniture: 'Móveis',
    lighting: 'Iluminação',
  };
  return labels[category.toLowerCase()] ?? category.replaceAll('-', ' ');
}

function Status({ status }: { status: State }) {
  const text: Record<State, string> = { scheduled: 'Agendado', live: 'Ao vivo', closed: 'Encerrado', cancelled: 'Cancelado' };
  return <span className={`status status-${status}`}><i />{text[status]}</span>;
}

function Button({ children, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button className={`button button-${variant}`} {...props}>{children}</button>;
}

function PageTitle({ eyebrow, title, detail, action, heading = 'h1' }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode; heading?: 'h1' | 'h2' }) {
  const Heading = heading;
  return <div className="page-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<Heading>{title}</Heading>{detail && <p>{detail}</p>}</div>{action && <div className="page-title-action">{action}</div>}</div>;
}

function Header() {
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const navigate = useNavigate();
  async function signOut() { await logout(); setMenu(false); navigate('/'); }
  return <header className="site-header"><div className="header-inner">
    <Link className="brand" to="/"><span className="brand-mark">V</span><span>verzel<span className="brand-sub">LEILÕES</span></span></Link>
    <button className="mobile-menu" aria-label={menu ? 'Fechar navegação' : 'Abrir navegação'} aria-expanded={menu} aria-controls="primary-navigation" onClick={() => setMenu(!menu)}>{menu ? '×' : '☰'}</button>
    <nav id="primary-navigation" className={`main-nav ${menu ? 'nav-open' : ''}`} aria-label="Navegação principal">
      <NavLink to="/" end onClick={() => setMenu(false)}>Explorar lotes</NavLink>
      {user?.role === 'BIDDER' && <><NavLink to="/wallet" onClick={() => setMenu(false)}>Carteira</NavLink><NavLink to="/my-lots" onClick={() => setMenu(false)}>Meus lances</NavLink></>}
      {user?.role === 'SELLER' && <NavLink to="/seller" onClick={() => setMenu(false)}>Painel do leiloeiro</NavLink>}
      <NavLink to="/about-audit" onClick={() => setMenu(false)}>Auditoria pública</NavLink>
    </nav>
    <div className="header-account">
      {user ? <><span className="account-greeting">Olá, {user.displayName.split(' ')[0]}</span><button className="sign-out" onClick={signOut}>Sair</button></> : <Link className="button button-dark" to="/login">Entrar</Link>}
    </div>
  </div></header>;
}

function Shell() {
  const { loading } = useAuth();
  return <><Header /><main className="main-content"><Routes>
    <Route path="/" element={<BrowsePage />} />
    <Route path="/lot/:id" element={<LotPage />} />
    <Route path="/audit/:id" element={<AuditPage />} />
    <Route path="/receipt/:token" element={<ReceiptPage />} />
    <Route path="/login" element={<AuthPage mode="login" />} />
    <Route path="/register" element={<AuthPage mode="register" />} />
    <Route path="/wallet" element={<Guard role="BIDDER" loading={loading}><WalletPage /></Guard>} />
    <Route path="/my-lots" element={<Guard role="BIDDER" loading={loading}><ActivityPage /></Guard>} />
    <Route path="/seller" element={<Guard role="SELLER" loading={loading}><SellerPage /></Guard>} />
    <Route path="/about-audit" element={<AuditInfoPage />} />
    <Route path="*" element={<NotFound />} />
  </Routes></main><Footer /></>;
}

function Guard({ role, loading, children }: { role: User['role']; loading: boolean; children: ReactNode }) {
  const { user } = useAuth();
  if (loading) return <div className="page-wrap"><Loading /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={user.role === 'SELLER' ? '/seller' : '/'} replace />;
  return <>{children}</>;
}

function Footer() {
  return <footer className="site-footer"><div className="footer-inner"><span>Verzel Leilões <span className="muted">· transparência em cada lance</span></span><Link to="/about-audit">Como a auditoria funciona</Link></div></footer>;
}

function Loading({ label = 'Carregando…' }: { label?: string }) { return <div className="loading"><span className="spinner" />{label}</div>; }

function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="notice notice-error"><strong>Não foi possível carregar esta informação.</strong><span>{message}</span>{retry && <button className="text-button" onClick={retry}>Tentar novamente</button>}</div>;
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function LotCard({ lot }: { lot: Lot }) {
  const shownBid = lot.currentBidCents ?? lot.startingCents;
  const priceLabel = lot.status === 'closed' ? 'Lance final' : lot.currentBidCents === null ? 'Lance inicial' : 'Lance atual';
  return <article className="lot-card">
    <Link to={`/lot/${lot.id}`} className="lot-image-link" aria-label={`Ver lote ${lot.title}`}>
      <img className="lot-image" src={lot.imageUrl} alt={lot.title} loading="lazy" />
      <Status status={lot.status} />
    </Link>
    <div className="lot-card-content"><div className="lot-card-category">{categoryLabel(lot.item?.category)}</div>
      <h3><Link to={`/lot/${lot.id}`}>{lot.title}</Link></h3>
      <div className="lot-card-foot"><div><span className="muted small-label">{priceLabel}</span><strong>{money(shownBid)}</strong></div>
        <div className="lot-time"><span className="muted small-label">{lot.status === 'scheduled' ? 'Começa em' : lot.status === 'closed' ? 'Encerrado em' : 'Termina em'}</span><strong>{dateTime(lot.status === 'scheduled' ? lot.startsAt : lot.endsAt)}</strong></div>
      </div>
      <Link className="lot-open-link" to={`/lot/${lot.id}`}>Acessar lote <span aria-hidden="true">↗</span></Link>
    </div>
  </article>;
}

function BrowsePage() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'all' | State>('all');
  const [query, setQuery] = useState('');
  async function load() {
    setLoading(true); setError('');
    try { setLots((await api<{lots: Lot[]}>('/lots')).lots); }
    catch (err) { setError(err instanceof Error ? err.message : 'Tente novamente.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const visibleLots = useMemo(() => lots.filter((lot) => (tab === 'all' || lot.status === tab) && lot.title.toLowerCase().includes(query.toLowerCase())), [lots, tab, query]);
  const liveCount = lots.filter((lot) => lot.status === 'live').length;
  return <div className="page-wrap browse-page">
    <section className="hero"><div className="hero-copy"><div className="eyebrow hero-eyebrow"><span className="live-dot" /> DISPUTAS EM TEMPO REAL</div>
      <h1>O próximo lance<br /><em>pode ser seu.</em></h1><p>Peças selecionadas. Disputas ao vivo. Cada lance fica registrado para consulta pública.</p>
      <a href="#vitrine" className="button button-lime">Explorar os lotes <span>↓</span></a></div>
      <div className="hero-side"><div className="hero-figure"><div className="figure-top"><span>AGORA NA CASA</span><span className="figure-mark">V</span></div><div className="figure-number">{String(liveCount).padStart(2, '0')}</div><div className="figure-caption">{liveCount === 1 ? 'lote ao vivo' : 'lotes ao vivo'}<span className="figure-pulse" /></div><div className="figure-rule" /><p>Todos os resultados podem ser conferidos no registro de auditoria.</p></div><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /></div>
    </section>
    <section id="vitrine" className="market-section"><PageTitle heading="h2" eyebrow="CATÁLOGO DA CASA" title="Lotes da casa" detail="Explore disputas ao vivo, acompanhe lotes agendados e consulte resultados anteriores." action={<span className="catalog-total">{lots.length} lotes</span>} />
      <div className="catalog-tools"><div className="filter-tabs" role="group" aria-label="Filtrar lotes por status">
        {[['all','Todos'],['live','Ao vivo'],['scheduled','Agendados'],['closed','Encerrados']].map(([key,label]) => <button key={key} className={tab === key ? 'filter-tab selected' : 'filter-tab'} onClick={() => setTab(key as typeof tab)} aria-pressed={tab === key}>{label}</button>)}
      </div><label className="search-field"><span aria-hidden="true">⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar um lote" aria-label="Buscar lotes por título" /></label></div>
      {loading ? <Loading label="Carregando lotes" /> : error ? <ErrorState message={error} retry={() => void load()} /> : visibleLots.length ? <div className="lot-grid">{visibleLots.map((lot) => <LotCard key={lot.id} lot={lot} />)}</div> : <Empty title="Nenhum lote nesta seleção" detail={query ? 'Tente outro termo de busca.' : 'Volte em breve para acompanhar novas ofertas.'} />}
    </section>
    <section className="assurance-row"><div><span className="assurance-icon">⌁</span><strong>Lances ao vivo</strong><span>Atualizações instantâneas sem recarregar.</span></div><div><span className="assurance-icon">⌕</span><strong>Registro público</strong><span>Qualquer pessoa pode verificar o histórico.</span></div><div><span className="assurance-icon">◉</span><strong>Reserva de lance</strong><span>O valor fica reservado enquanto você lidera.</span></div></section>
  </div>;
}

function useCountdown(date: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((new Date(date).getTime() - now) / 1000));
  const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); const secs = seconds % 60;
  return { seconds, label: `${days ? `${days}d ` : ''}${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}` };
}

function LotPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [lot, setLot] = useState<Lot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [feedback, setFeedback] = useState<{type:'success'|'error'; text:string} | null>(null);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const countdown = useCountdown(lot?.endsAt ?? new Date().toISOString());
  async function load() {
    setError('');
    try { setLot((await api<{lot: Lot}>(`/lots/${id}`)).lot); }
    catch (err) { setError(err instanceof Error ? err.message : 'Tente novamente.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { setLoading(true); void load(); }, [id]);
  useEffect(() => {
    if (!id) return;
    const socket = io({ withCredentials: true, reconnection: true, reconnectionAttempts: Infinity });
    socket.on('connect', () => { setConnected(true); socket.emit('lot:join', id); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('lot:update', (state: any) => {
      if (state.lotId !== id) return;
      setLot((previous) => previous ? { ...previous, currentBidCents: state.currentBidCents, startsAt: state.startsAt, endsAt: state.endsAt,
        status: state.state, bids: state.bids.map((bid: any) => ({ ...bid, bidderPublicId: bid.bidderPublicId })) } : previous);
    });
    return () => { socket.emit('lot:leave', id); socket.disconnect(); };
  }, [id]);

  useEffect(() => {
    if (countdown.seconds === 0 && lot?.status === 'live') {
      setLot((current) => current ? { ...current, status: 'closed' } : current);
      const timer = setTimeout(() => { void load(); }, 1500);
      return () => clearTimeout(timer);
    }
  }, [countdown.seconds, lot?.status]);

  const minimum = lot ? (lot.currentBidCents === null ? lot.startingCents : lot.currentBidCents + lot.incrementCents) : 0;
  const leading = Boolean(user && lot && lot.bids?.[0]?.bidderPublicId === user.publicId && lot.status === 'live');
  const outbid = Boolean(user?.role === 'BIDDER' && lot?.userHasBid && lot.status === 'live' && !leading);
  async function submitBid(event: FormEvent) {
    event.preventDefault(); setFeedback(null);
    if (!user) { navigate('/login'); return; }
    if (user.role !== 'BIDDER') { setFeedback({type:'error',text:'O perfil de leiloeiro não pode dar lances.'}); return; }
    const amountCents = centsFromInput(amount);
    if (!amountCents) { setFeedback({type:'error',text:'Digite um valor de lance válido.'}); return; }
    setSending(true);
    try {
      const response = await api<{extended:boolean}>((`/lots/${id}/bids`), { method:'POST', body:JSON.stringify({amountCents}) });
      setAmount(''); setFeedback({type:'success',text:response.extended ? 'Lance aceito. O encerramento foi prorrogado por mais dois minutos.' : 'Lance aceito. Você está na disputa.'});
      await load();
    } catch (err) { setFeedback({type:'error',text:err instanceof ApiError ? err.message : 'Não foi possível enviar o lance.'}); }
    finally { setSending(false); }
  }

  if (loading) return <div className="page-wrap"><Loading label="Abrindo a sala do lote" /></div>;
  if (error || !lot) return <div className="page-wrap"><ErrorState message={error || 'Lote não encontrado.'} retry={() => { setLoading(true); void load(); }} /></div>;
  const bids = lot.bids ?? [];
  return <div className="page-wrap lot-page">
    <div className="breadcrumb"><Link to="/">Lotes</Link><span>/</span><span>{lot.title}</span></div>
    <div className="lot-detail-grid">
      <section className="lot-detail-main">
        <div className="lot-detail-image"><img src={lot.imageUrl} alt={lot.title} /><Status status={lot.status} /><Link className="audit-chip" to={`/audit/${lot.id}`}>◉ Auditoria pública</Link></div>
        <div className="lot-detail-copy"><div className="eyebrow">{categoryLabel(lot.item?.category)} <span>·</span> {lot.item?.brand ?? 'Verzel'}</div><h1>{lot.title}</h1><p className="lot-description">{lot.description}</p>
          <div className="item-facts">{lot.item?.rating !== null && lot.item?.rating !== undefined && <div><span>Avaliação</span><strong>{lot.item.rating.toFixed(1)} / 5</strong></div>}{lot.item?.stock !== null && lot.item?.stock !== undefined && <div><span>Estoque de origem</span><strong>{lot.item.stock} un.</strong></div>}<div><span>Lote</span><strong>#{lot.id.slice(0,8).toUpperCase()}</strong></div></div>
          <div className="seller-note"><span className="seller-avatar">{lot.sellerPublicId.slice(-1)}</span><div><span className="muted small-label">Leiloado por</span><strong>{lot.sellerName ?? `Leiloeiro ${lot.sellerPublicId}`}</strong></div><span className="verified-mark">✓</span></div>
        </div>
      </section>
      <aside className="lot-bid-panel">
        <div className="panel-kicker"><span className={connected ? 'connection-dot connected' : 'connection-dot'} />{connected ? 'SALA CONECTADA' : 'CONECTANDO À SALA'}</div>
        <div className="bid-current"><span>{lot.currentBidCents === null ? 'Lance inicial' : 'Lance atual'}</span><strong>{money(lot.currentBidCents ?? lot.startingCents)}</strong><small>Incremento mínimo {money(lot.incrementCents)}</small></div>
        <div className="countdown-box"><span>{lot.status === 'scheduled' ? 'COMEÇA EM' : lot.status === 'closed' ? 'ENCERRADO EM' : 'TEMPO RESTANTE'}</span><strong>{lot.status === 'scheduled' ? dateTime(lot.startsAt) : lot.status === 'closed' ? dateTime(lot.endsAt) : countdown.label}</strong></div>
        {leading && <div className="notice notice-leading">✦ Você está liderando este lote.</div>}
        {outbid && <div className="notice notice-error" role="status">Seu lance foi superado. O saldo reservado já foi liberado; você pode cobrir a oferta atual.</div>}
        {user?.role === 'BIDDER' && lot.status === 'live' && !leading ? <form onSubmit={submitBid} className="bid-form">
          <label htmlFor="bid-amount">Seu lance <span>Mínimo {money(minimum)}</span></label>
          <div className="money-input"><span>R$</span><input id="bid-amount" inputMode="decimal" type="number" step="0.01" min={(minimum / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={(minimum / 100).toFixed(2)} required /></div>
          <Button type="submit" disabled={sending}>{sending ? 'Enviando…' : 'Confirmar lance'} <span>↗</span></Button>
          <small className="form-hint">O valor do seu lance ficará reservado enquanto você liderar.</small>
          {feedback && <div className={`notice ${feedback.type === 'error' ? 'notice-error' : 'notice-success'}`} role="status">{feedback.text}</div>}
        </form> : !user ? <div className="sign-in-prompt"><p>Entre para acompanhar e participar deste leilão.</p><Link to="/login" className="button button-primary">Entrar para dar lance</Link></div> : user.role === 'SELLER' ? <div className="notice notice-info">Contas de leiloeiro acompanham lotes, mas não participam dos lances.</div> : lot.status === 'scheduled' ? <div className="notice notice-info">Este lote ainda não começou. Volte no horário de abertura.</div> : lot.status === 'closed' ? <div className="notice notice-info">A disputa foi encerrada. Consulte o resultado e a auditoria abaixo.</div> : null}
        {user?.role === 'BIDDER' && feedback && !(lot.status === 'live' && !leading) && <div className={`notice ${feedback.type === 'error' ? 'notice-error' : 'notice-success'}`}>{feedback.text}</div>}
        <div className="panel-footnote">✓ Lances validados pelo servidor · Valores em reais</div>
      </aside>
    </div>
    <div className="lot-bottom-grid"><section className="history-panel"><div className="section-heading"><div><div className="eyebrow">ATIVIDADE VERIFICÁVEL</div><h2>Histórico de lances <span className="count-pill">{bids.length}</span></h2></div><Link to={`/audit/${lot.id}`} className="text-link">Ver auditoria completa ↗</Link></div>
        {bids.length ? <div className="bid-list">{bids.map((bid,index) => <div className={`bid-row ${index === 0 ? 'bid-row-current' : ''}`} key={bid.id}><div className="bid-avatar">{bid.bidderPublicId.slice(-1)}</div><div className="bid-person"><strong>{bid.bidderPublicId}</strong><span>{index === 0 && lot.status === 'live' ? 'Liderando agora' : dateTime(bid.createdAt)}</span></div><strong className="bid-amount">{money(bid.amountCents)}</strong>{index === 0 && <span className="leader-label">LÍDER</span>}</div>)}</div> : <p className="muted">Ainda não há lances registrados neste lote.</p>}
      </section><section className="lot-schedule"><div className="eyebrow">AGENDA</div><h2>Horários do lote</h2><div className="schedule-line"><span className="schedule-dot" /><div><span>Início</span><strong>{dateTime(lot.startsAt)}</strong></div></div><div className="schedule-line"><span className="schedule-dot schedule-end" /><div><span>Encerramento previsto</span><strong>{dateTime(lot.endsAt)}</strong></div></div><p>Um lance nos dois minutos finais prorroga o encerramento para dois minutos depois do lance.</p></section></div>
  </div>;
}

function AuditPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<any>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  async function load() { setLoading(true); setError(''); try { setData(await api(`/lots/${id}/audit`)); } catch (e) { setError(e instanceof Error ? e.message : 'Tente novamente.'); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, [id]);
  if (loading) return <div className="page-wrap"><Loading label="Conferindo histórico de lances" /></div>;
  if (error || !data) return <div className="page-wrap"><ErrorState message={error || 'Lote não encontrado.'} retry={() => void load()} /></div>;
  const verified = data.audit.status === 'verified';
  return <div className="page-wrap narrow-page"><div className="breadcrumb"><Link to={`/lot/${id}`}>Voltar ao lote</Link><span>/</span><span>Auditoria</span></div><PageTitle eyebrow="REGISTRO PÚBLICO" title="Auditoria do lote" detail={data.lot.title} />
    <div className={`audit-result ${verified ? 'audit-verified' : 'audit-failed'}`}><span className="audit-symbol">{verified ? '✓' : '!'}</span><div><strong>{verified ? 'Verificação concluída' : data.audit.status === 'unverifiable' ? 'Não foi possível verificar' : 'Divergência encontrada'}</strong><p>{data.audit.message}</p></div><span className="audit-count">{data.bids.length} {data.bids.length === 1 ? 'lance' : 'lances'}</span></div>
    <div className="audit-explainer"><strong>Sobre esta conferência</strong><p>Conferimos a ordem e os valores dos lances deste lote. Os participantes são identificados por pseudônimos para preservar seus dados pessoais.</p></div>
    <div className="history-panel audit-history"><div className="section-heading"><div><div className="eyebrow">ORDENADO POR SEQUÊNCIA</div><h2>Eventos registrados</h2></div></div>
      {data.bids.length ? <div className="bid-list">{data.bids.map((bid: any) => <div className="bid-row" key={bid.sequence}><span className="sequence-number">{String(bid.sequence).padStart(2,'0')}</span><div className="bid-person"><strong>{bid.bidderPublicId}</strong><span>{dateTime(bid.createdAt)}</span></div><strong className="bid-amount">{money(bid.amountCents)}</strong></div>)}</div> : <p className="muted">Nenhum lance foi registrado. A cabeça inicial do histórico também foi verificada.</p>}
    </div>
  </div>;
}

function ReceiptPage() {
  const { token = '' } = useParams();
  const [receipt, setReceipt] = useState<any>(null); const [error, setError] = useState(''); const [copied, setCopied] = useState(false);
  useEffect(() => { api<{receipt:any}>(`/receipts/${token}`).then((response) => setReceipt(response.receipt)).catch((e) => setError(e instanceof Error ? e.message : 'Comprovante indisponível.')); }, [token]);
  async function share() {
    const url = window.location.href;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { window.prompt('Copie o link público do comprovante:', url); }
  }
  if (error) return <div className="page-wrap"><ErrorState message={error} /></div>;
  if (!receipt) return <div className="page-wrap"><Loading label="Carregando comprovante" /></div>;
  return <div className="page-wrap narrow-page receipt-page"><div className="receipt-top"><span className="receipt-brand"><span className="brand-mark">V</span> VERZEL LEILÕES</span><span className="receipt-stamp">COMPROVANTE PÚBLICO</span></div>
    <div className="receipt-card"><div className="receipt-check">{receipt.noWinner ? '—' : '✓'}</div><div className="eyebrow">{receipt.noWinner ? 'LOTE ENCERRADO' : 'ARREMATE CONFIRMADO'}</div><h1>{receipt.noWinner ? 'Sem vencedor' : 'Lote arrematado'}</h1><p className="receipt-subtitle">{receipt.title}</p>
      <img className="receipt-image" src={receipt.imageUrl} alt={receipt.title} />
      <div className="receipt-value"><span>Valor final</span><strong>{receipt.noWinner ? '—' : money(receipt.finalCents)}</strong></div>
      <div className="receipt-details"><div><span>Encerrado em</span><strong>{dateTime(receipt.closedAt)}</strong></div><div><span>Vencedor</span><strong>{receipt.winnerPublicId ?? 'Não houve lances'}</strong></div><div><span>Leiloeiro</span><strong>{receipt.sellerPublicId}</strong></div><div><span>Identificação do lote</span><strong>#{receipt.lotId.slice(0,8).toUpperCase()}</strong></div></div>
      <div className="receipt-actions"><Button onClick={() => void share()}>{copied ? 'Link copiado ✓' : 'Compartilhar comprovante ↗'}</Button><Button variant="secondary" onClick={() => window.print()}>Imprimir</Button></div>
    </div><p className="receipt-note">Este documento é público e pode ser consultado sem login. Os participantes são identificados por pseudônimos.</p>
  </div>;
}

function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register'; const { user, login, register } = useAuth(); const navigate = useNavigate();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [displayName, setDisplayName] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (user) navigate(user.role === 'SELLER' ? '/seller' : '/', {replace:true}); }, [user]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try { const authenticated = isRegister ? await register({displayName,email,password}) : await login(email,password); navigate(authenticated.role === 'SELLER' ? '/seller' : '/', {replace:true}); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível entrar.'); }
    finally { setBusy(false); }
  }
  return <div className="auth-layout"><section className="auth-aside"><div className="eyebrow">A CASA ESTÁ ABERTA</div><h1>Uma disputa<br />clara começa<br /><em>por você.</em></h1><p>Entre nos leilões ao vivo, acompanhe cada mudança e confira o registro público depois.</p><div className="auth-aside-bottom">◆ &nbsp; Lances claros e histórico público</div></section>
    <section className="auth-panel"><div className="auth-form-wrap"><div className="eyebrow">{isRegister ? 'CRIE SUA CONTA' : 'BEM-VINDO DE VOLTA'}</div><h2>{isRegister ? 'Faça parte da disputa' : 'Acesse sua conta'}</h2><p>{isRegister ? 'Cadastre-se como licitante para participar dos leilões.' : 'Use suas credenciais para continuar.'}</p>
      <form className="stack-form" onSubmit={submit}>{isRegister && <label>Nome para exibição<input required minLength={2} maxLength={80} value={displayName} onChange={(e)=>setDisplayName(e.target.value)} placeholder="Seu nome" /></label>}
        <label>E-mail<input type="email" required maxLength={254} autoComplete="email" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="voce@email.com" /></label>
        <label>Senha<input type="password" required minLength={isRegister ? 10 : 1} maxLength={100} autoComplete={isRegister?'new-password':'current-password'} value={password} onChange={(e)=>setPassword(e.target.value)} placeholder={isRegister?'Pelo menos 10 caracteres':'Sua senha'} /></label>
        {error && <div className="notice notice-error" role="alert">{error}</div>}<Button type="submit" disabled={busy}>{busy ? 'Aguarde…' : isRegister ? 'Criar conta' : 'Entrar'} <span>↗</span></Button>
      </form><div className="auth-switch">{isRegister ? <>Já tem conta? <Link to="/login">Entrar</Link></> : <>Ainda não tem conta? <Link to="/register">Criar conta</Link></>}</div>
    </div></section></div>;
}

function WalletPage() {
  const [wallet, setWallet] = useState<any>(null); const [error,setError] = useState(''); const [amount,setAmount] = useState('100'); const [busy,setBusy] = useState(false); const [message,setMessage] = useState('');
  async function load() { setError(''); try { setWallet(await api('/wallet')); } catch (e) { setError(e instanceof Error?e.message:'Tente novamente.'); } }
  useEffect(()=>{void load();},[]);
  async function deposit(event:FormEvent) { event.preventDefault(); setBusy(true); setError(''); setMessage(''); const amountCents=centsFromInput(amount); if(!amountCents||amountCents<100){setBusy(false);setError('O depósito mínimo é R$ 1,00.');return;} try{await api('/wallet/deposits',{method:'POST',body:JSON.stringify({amountCents})});setMessage(`${money(amountCents)} adicionados à sua carteira.`);await load();}catch(e){setError(e instanceof Error?e.message:'Não foi possível depositar.');}finally{setBusy(false);} }
  if(!wallet&&!error)return <div className="page-wrap"><Loading label="Carregando carteira" /></div>;
  return <div className="page-wrap narrow-page"><PageTitle eyebrow="SUA CONTA" title="Carteira" detail="Saldo e movimentações do seu perfil de licitante." />{error&&<ErrorState message={error} retry={()=>void load()} />}
    {wallet&&<><section className="wallet-summary"><div className="wallet-balance"><span>Saldo total</span><strong>{money(wallet.wallet.totalCents)}</strong><small>Atualizado agora</small></div><div className="wallet-split"><div><span>Comprometido</span><strong>{money(wallet.wallet.committedCents)}</strong><small>Reservado em lotes que você lidera</small></div><div><span>Disponível</span><strong className="available-amount">{money(wallet.wallet.availableCents)}</strong><small>Livre para novos lances</small></div></div></section>
      <section className="deposit-panel"><div><div className="eyebrow">SALDO FICTÍCIO</div><h2>Adicionar saldo</h2><p>O depósito é simulado e fica registrado no histórico da carteira.</p></div><form onSubmit={deposit} className="deposit-form"><label htmlFor="deposit-amount">Valor do depósito</label><div className="money-input"><span>R$</span><input id="deposit-amount" type="number" min="1" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></div><Button disabled={busy}>{busy?'Processando…':'Adicionar saldo'}</Button></form>{message&&<div className="notice notice-success">{message}</div>}{error&&<div className="notice notice-error">{error}</div>}</section>
      <section className="history-panel wallet-history"><div className="section-heading"><div><div className="eyebrow">MOVIMENTAÇÕES</div><h2>Últimas operações</h2></div></div>{wallet.transactions.length ? <div className="transaction-list">{wallet.transactions.map((tx:any)=><div className="transaction-row" key={tx.id}><span className={`transaction-icon tx-${tx.kind.toLowerCase()}`}>{tx.kind==='DEPOSIT'?'+':tx.kind==='AUCTION_DEBIT'?'−':tx.kind==='SELLER_CREDIT'?'+':'↔'}</span><div><strong>{transactionLabel(tx.kind)}</strong><span>{dateTime(tx.createdAt)}</span></div><strong className={['DEPOSIT','SELLER_CREDIT','RELEASE'].includes(tx.kind)?'money-positive':'money-neutral'}>{['DEPOSIT','SELLER_CREDIT'].includes(tx.kind)?'+':''}{money(tx.amountCents)}</strong></div>)}</div>:<Empty title="Sem movimentações" detail="Depósitos e lances aparecerão aqui." />}</section></>}
  </div>;
}

function transactionLabel(kind:string) { return ({DEPOSIT:'Depósito simulado',HOLD:'Valor reservado em lance',RELEASE:'Reserva liberada',AUCTION_DEBIT:'Arremate debitado',SELLER_CREDIT:'Crédito ao leiloeiro'} as Record<string,string>)[kind]??kind; }

function ActivityPage() {
  const [lots,setLots]=useState<any[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [copied,setCopied]=useState('');
  async function load(){setLoading(true);setError('');try{setLots((await api<{lots:any[]}>('/me/activity')).lots);}catch(e){setError(e instanceof Error?e.message:'Tente novamente.');}finally{setLoading(false);}}
  useEffect(()=>{void load();},[]);
  async function share(token:string){try{await navigator.clipboard.writeText(`${window.location.origin}/receipt/${token}`);setCopied(token);setTimeout(()=>setCopied(''),2500);}catch{window.prompt('Copie o link público:',`${window.location.origin}/receipt/${token}`);}}
  return <div className="page-wrap"><PageTitle eyebrow="SUA ATIVIDADE" title="Meus lances" detail="Acompanhe sua posição em cada disputa e consulte seus arremates." action={<Link to="/wallet" className="button button-secondary">Ver carteira ↗</Link>} />
    {loading?<Loading label="Carregando sua atividade"/>:error?<ErrorState message={error} retry={()=>void load()}/>:lots.length?<div className="activity-list">{lots.map((lot:any)=><article className="activity-card" key={lot.id}><Link to={`/lot/${lot.id}`} className="activity-image" aria-label={`Abrir lote ${lot.title}`}><img src={lot.imageUrl} alt=""/></Link><div className="activity-main"><div className="activity-topline"><Status status={lot.status}/>{lot.won&&<span className="won-tag">ARREMATADO</span>}</div><h2><Link to={`/lot/${lot.id}`}>{lot.title}</Link></h2><div className="activity-stats"><div><span>Seu maior lance</span><strong>{money(lot.myMaxBidCents)}</strong></div><div><span>Lance atual</span><strong>{money(lot.currentBidCents)}</strong></div><div><span>Sua posição</span><strong className={lot.leading?'position-leading':''}>{lot.leading?'Você está liderando':lot.won?'Você venceu':lot.status==='closed'?'Você não venceu':'Você foi superado'}</strong></div></div>{lot.won&&lot.receiptToken&&<div className="activity-actions"><Link className="text-link" to={`/receipt/${lot.receiptToken}`}>Abrir comprovante ↗</Link><Button variant="secondary" onClick={()=>void share(lot.receiptToken)}>{copied===lot.receiptToken?'Link copiado ✓':'Compartilhar'}</Button></div>}</div></article>)}</div>:<Empty title="Você ainda não participou de um lote" detail="Explore as disputas ao vivo e entre quando encontrar um item que goste." action={<Link to="/" className="button button-primary">Explorar lotes</Link>} />}
  </div>;
}

function SellerPage() {
  const [query,setQuery]=useState(''); const [products,setProducts]=useState<Item[]>([]); const [selected,setSelected]=useState<Item|null>(null); const [searchBusy,setSearchBusy]=useState(false); const [searchError,setSearchError]=useState(''); const [searched,setSearched]=useState(false);
  const [lots,setLots]=useState<any[]>([]); const [summary,setSummary]=useState<any>(null); const [pageError,setPageError]=useState(''); const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(false); const [feedback,setFeedback]=useState('');
  const [title,setTitle]=useState(''); const [description,setDescription]=useState(''); const [starting,setStarting]=useState('100'); const [increment,setIncrement]=useState('5');
  const localDate=(offset:number)=>{const date=new Date(Date.now()+offset);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  const [startsAt,setStartsAt]=useState(()=>localDate(10*60_000));const [endsAt,setEndsAt]=useState(()=>localDate(70*60_000));
  async function load(){setPageError('');setLoading(true);try{const [lotResponse,stats]=await Promise.all([api<{lots:any[]}>('/seller/lots'),api('/seller/summary')]);setLots(lotResponse.lots);setSummary(stats);}catch(e){setPageError(e instanceof Error?e.message:'Tente novamente.');}finally{setLoading(false);}}
  useEffect(()=>{void load();},[]);
  async function search(event:FormEvent){event.preventDefault();setSearchBusy(true);setSearchError('');setSearched(false);try{setProducts((await api<{products:Item[];total:number}>(`/seller/products?q=${encodeURIComponent(query)}`)).products);setSelected(null);setSearched(true);}catch(e){setSearchError(e instanceof Error?e.message:'Busca indisponível.');}finally{setSearchBusy(false);}}
  function choose(product:Item){setSelected(product);setTitle(product.title);setDescription(product.description);setSearchError('');}
  async function createLot(event:FormEvent){event.preventDefault();if(!selected)return;setBusy(true);setFeedback('');setPageError('');const startingCents=centsFromInput(starting),incrementCents=centsFromInput(increment);if(!startingCents||!incrementCents){setPageError('Informe valores de lance válidos.');setBusy(false);return;}try{await api('/seller/lots',{method:'POST',body:JSON.stringify({productId:selected.id,title,description,startingCents,incrementCents,startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString()})});setFeedback('Lote criado e publicado. Os detalhes foram salvos para que o leilão funcione sem depender da API externa.');setSelected(null);setProducts([]);setTitle('');setDescription('');await load();}catch(e){setPageError(e instanceof Error?e.message:'Não foi possível criar o lote.');}finally{setBusy(false);}}
  async function cancelLot(id:string){if(!window.confirm('Cancelar este lote? Só é possível cancelar lotes sem lances.'))return;setPageError('');try{await api(`/seller/lots/${id}`,{method:'DELETE'});await load();}catch(e){setPageError(e instanceof Error?e.message:'Não foi possível cancelar.');}}
  return <div className="page-wrap seller-page"><PageTitle eyebrow="ÁREA DO LEILOEIRO" title="Painel da casa" detail="Encontre uma peça, publique o lote e acompanhe o resultado." />
    {summary&&<div className="seller-kpis"><div><span>Todos os lotes</span><strong>{summary.total}</strong></div><div><span>Em disputa</span><strong>{summary.active}</strong></div><div><span>Encerrados</span><strong>{summary.closed}</strong></div><div><span>Valor em arremates</span><strong>{money(summary.receivedCents)}</strong></div></div>}
    {pageError&&<div className="notice notice-error">{pageError}</div>}{feedback&&<div className="notice notice-success">{feedback}</div>}
    <div className="seller-workspace"><section className="seller-search-panel"><div className="section-heading"><div><div className="eyebrow">CATÁLOGO EXTERNO · DUMMYJSON</div><h2>Escolha um item</h2></div><span className="api-pill">API pública</span></div><p className="muted">Os dados do item serão copiados para o lote. Revise título e descrição antes de publicar.</p>
      <form className="seller-search" onSubmit={search}><label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Pesquisar produtos no catálogo" minLength={2} required value={query} onChange={(e)=>{setQuery(e.target.value);setProducts([]);setSelected(null);setSearchError('');setSearched(false);}} placeholder="Ex.: relógio, câmera, fone" /></label><Button disabled={searchBusy}>{searchBusy?'Buscando…':'Buscar'}</Button></form>
      {searchError&&<div className="notice notice-error">{searchError}</div>}{products.length>0&&<div className="product-results">{products.map((product)=><button key={product.id} type="button" className={`product-option ${selected?.id===product.id?'product-selected':''}`} onClick={()=>choose(product)}><img src={product.thumbnail} alt=""/><span><strong>{product.title}</strong><small>{categoryLabel(product.category)} · Origem {money(Math.round(product.price*100))}</small></span><span className="product-select-mark">{selected?.id===product.id?'✓':'+'}</span></button>)}</div>}
      {!products.length&&!searchBusy&&!searchError&&<div className="search-empty"><span>⌕</span><p>{searched?`Nenhum item encontrado para “${query.trim()}”. Tente outro termo.`:'Pesquise no catálogo para encontrar o próximo lote.'}</p></div>}
    </section>
      <section className="create-lot-panel"><div className="eyebrow">CONFIGURE A DISPUTA</div><h2>Novo lote</h2>{selected?<form className="stack-form seller-lot-form" onSubmit={createLot}><div className="selected-product"><img src={selected.thumbnail} alt=""/><div><span className="small-label muted">ITEM SELECIONADO</span><strong>{selected.title}</strong><button type="button" className="text-button" onClick={()=>setSelected(null)}>Trocar item</button></div></div>
        <label>Título do lote<input required minLength={3} maxLength={180} value={title} onChange={(e)=>setTitle(e.target.value)} /></label><label>Descrição<textarea maxLength={4000} rows={3} value={description} onChange={(e)=>setDescription(e.target.value)} /></label>
        <div className="form-two-col"><label>Lance inicial (R$)<input required type="number" min="0.01" step="0.01" value={starting} onChange={(e)=>setStarting(e.target.value)} /></label><label>Incremento mínimo (R$)<input required type="number" min="0.01" step="0.01" value={increment} onChange={(e)=>setIncrement(e.target.value)} /></label></div>
        <div className="form-two-col"><label>Início<input required type="datetime-local" value={startsAt} onChange={(e)=>setStartsAt(e.target.value)} /></label><label>Encerramento<input required type="datetime-local" value={endsAt} onChange={(e)=>setEndsAt(e.target.value)} /></label></div>
        <div className="form-note">O início deve ser futuro. O lote pode durar até 30 dias.</div><Button disabled={busy}>{busy?'Publicando…':'Publicar lote'} <span>↗</span></Button>
      </form>:<div className="create-placeholder"><span className="placeholder-icon">＋</span><strong>Escolha um produto para continuar</strong><p>O formulário do lote aparece após selecionar um item nos resultados da busca.</p></div>}</section>
    </div>
    <section className="seller-lots-section"><div className="section-heading"><div><div className="eyebrow">SEUS LOTES</div><h2>Publicações da casa</h2></div><button className="text-button" disabled={loading} onClick={()=>void load()}>{loading?'Atualizando…':'Atualizar ↻'}</button></div>
      {loading&&!lots.length?<Loading label="Carregando suas publicações"/>:pageError&&!lots.length?<ErrorState message={pageError} retry={()=>void load()}/>:lots.length?<div className="seller-lot-list">{lots.map((lot:any)=><article className="seller-lot-row" key={lot.id}><img src={lot.imageUrl} alt=""/><div className="seller-lot-main"><div className="seller-lot-top"><Status status={lot.status}/><span className="muted">{lot.bidCount} {lot.bidCount===1?'lance':'lances'}</span></div><h3><Link to={`/lot/${lot.id}`}>{lot.title}</Link></h3><span className="muted small-label">{dateTime(lot.startsAt)} → {dateTime(lot.endsAt)}</span></div><div className="seller-lot-value"><span>{lot.status!=='closed'?'Lance atual':lot.finalCents!==null?`Arrematado por ${lot.winnerPublicId}`:lot.bidCount?'Liquidação pendente':'Encerrado sem lances'}</span><strong>{lot.finalCents!==null?money(lot.finalCents):lot.currentBidCents!==null?money(lot.currentBidCents):'—'}</strong></div><div className="seller-lot-actions"><Link to={`/audit/${lot.id}`} className="text-button">Auditoria</Link>{lot.receiptToken&&<Link to={`/receipt/${lot.receiptToken}`} className="text-button">Comprovante</Link>}{lot.canCancel&&<Button variant="danger" onClick={()=>void cancelLot(lot.id)}>Cancelar</Button>}</div></article>)}</div>:<Empty title="Sua casa ainda não publicou lotes" detail="Busque um item no catálogo acima e configure sua primeira disputa." />}
    </section>
  </div>;
}

function AuditInfoPage() {
  return <div className="page-wrap narrow-page"><PageTitle eyebrow="TRANSPARÊNCIA" title="Confira os lances de cada lote" detail="O registro público mostra a sequência e o resultado da conferência dos lances." />
    <div className="audit-process">{[['01','Registro','Cada lance mostra o valor, o pseudônimo de quem participou e o horário em que foi recebido.'],['02','Histórico conectado','Os registros seguem uma ordem. Alterações, remoções ou inserções são sinalizadas na conferência.'],['03','Proteção','O sistema protege o resumo do histórico no servidor para que ele possa ser conferido depois.'],['04','Conferência','A auditoria revisa os registros do lote e informa se os eventos correspondem ao histórico.']].map(([number,title,text])=><div className="audit-step" key={number}><span>{number}</span><div><h2>{title}</h2><p>{text}</p></div></div>)}</div>
    <div className="audit-explainer"><strong>Consulte uma disputa</strong><p>Abra um lote para acompanhar os lances e acessar a auditoria pública correspondente.</p><Link to="/#vitrine" className="button button-secondary">Explorar lotes ↗</Link></div>
  </div>;
}

function NotFound() { return <div className="page-wrap"><Empty title="Página não encontrada" detail="Esse caminho não está disponível." action={<Link className="button button-primary" to="/">Voltar para os lotes</Link>} /></div>; }

export default function App() { return <BrowserRouter><AuthProvider><Shell /></AuthProvider></BrowserRouter>; }
