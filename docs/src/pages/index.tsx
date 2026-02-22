import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

function HomepageHeader() {
    const { siteConfig } = useDocusaurusContext();
    return (
        <header className={clsx('hero hero--primary', styles.heroBanner)}>
            <div className="container">
                <img src="/img/logo-with-text.png" alt="PlugPort" style={{ maxWidth: 280, marginBottom: 20 }} />
                <Heading as="h1" className="hero__title">
                    {siteConfig.title}
                </Heading>
                <p className="hero__subtitle">{siteConfig.tagline}</p>
                <div className={styles.buttons}>
                    <Link className="button button--secondary button--lg" to="/docs/getting-started">
                        Get Started &rarr;
                    </Link>
                    <Link className="button button--outline button--lg" to="/docs/migration-guide"
                        style={{ marginLeft: '12px', borderColor: 'rgba(131,110,249,0.4)', color: '#a594ff' }}>
                        Migration Guide
                    </Link>
                </div>
                <div style={{ marginTop: '24px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <span className="badge badge--monad" style={{
                        background: 'linear-gradient(135deg, #836ef9, #4ecdc4)',
                        color: 'white', padding: '4px 12px', borderRadius: '100px', fontSize: '12px', fontWeight: 600
                    }}>Powered by MonadDb</span>
                    <span style={{
                        background: 'rgba(0,212,170,0.1)', color: '#00d4aa',
                        padding: '4px 12px', borderRadius: '100px', fontSize: '12px', fontWeight: 600,
                        border: '1px solid rgba(0,212,170,0.2)'
                    }}>Wire Protocol Compatible</span>
                    <span style={{
                        background: 'rgba(255,193,7,0.1)', color: '#ffc107',
                        padding: '4px 12px', borderRadius: '100px', fontSize: '12px', fontWeight: 600,
                        border: '1px solid rgba(255,193,7,0.2)'
                    }}>Free Tier Deployable</span>
                </div>
            </div>
        </header>
    );
}

const features = [
    {
        title: 'Drop-In MongoDB Replacement',
        emoji: '🔄',
        description: 'Use the same MongoDB drivers, queries, and tooling you already know. Change one URI and your app runs on MonadDb.',
    },
    {
        title: 'Verifiable Storage',
        emoji: '🔐',
        description: 'Every document write produces a cryptographic proof via MonadDb\'s Merkle Patricia Trie. Trust math, not servers.',
    },
    {
        title: 'Multi-Protocol Access',
        emoji: '🌐',
        description: 'Connect via MongoDB wire protocol (port 27017) or REST HTTP API (port 8080). Both served from one process.',
    },
    {
        title: 'SDKs for Every Stack',
        emoji: '📦',
        description: 'Native SDKs for Node.js, Python, and Go. Each mimics the official MongoDB driver API for zero learning curve.',
    },
    {
        title: 'Built-In Dashboard',
        emoji: '📊',
        description: 'Next.js 15 dashboard with query builder, document explorer, index manager, and real-time performance metrics.',
    },
    {
        title: 'Free Tier Ready',
        emoji: '☁️',
        description: 'Deploy on Railway, Vercel, and Docker Hub free tiers. CI/CD via GitHub Actions. Zero infrastructure cost to start.',
    },
];

function Feature({ title, emoji, description }: { title: string; emoji: string; description: string }) {
    return (
        <div className={clsx('col col--4')} style={{ marginBottom: '24px' }}>
            <div className="feature-card" style={{ height: '100%' }}>
                <div style={{ fontSize: '32px', marginBottom: '12px' }}>{emoji}</div>
                <Heading as="h3" style={{ fontSize: '18px', fontWeight: 700 }}>{title}</Heading>
                <p style={{ color: '#a0a3b1', fontSize: '14px', lineHeight: 1.6 }}>{description}</p>
            </div>
        </div>
    );
}

function HomepageFeatures() {
    return (
        <section style={{ padding: '48px 0' }}>
            <div className="container">
                <div className="row">
                    {features.map((props, idx) => (
                        <Feature key={idx} {...props} />
                    ))}
                </div>
            </div>
        </section>
    );
}

function QuickExample() {
    return (
        <section style={{ padding: '48px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="container">
                <Heading as="h2" style={{ textAlign: 'center', marginBottom: '32px' }}>
                    From MongoDB to MonadDb in 2 Lines
                </Heading>
                <div className="row">
                    <div className="col col--6">
                        <Heading as="h4" style={{ color: '#ff6b6b', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>Before (MongoDB)</Heading>
                        <pre style={{ background: '#111318', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '20px', fontSize: '13px' }}>
                            <code>{`import { MongoClient } from 'mongodb';

const client = await MongoClient.connect(
  'mongodb://localhost:27017'
);
const db = client.db('myapp');
const users = db.collection('users');
await users.insertOne({ name: 'Alice' });`}</code>
                        </pre>
                    </div>
                    <div className="col col--6">
                        <Heading as="h4" style={{ color: '#00d4aa', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>After (PlugPort)</Heading>
                        <pre style={{ background: '#111318', border: '1px solid rgba(0,212,170,0.2)', borderRadius: '12px', padding: '20px', fontSize: '13px' }}>
                            <code>{`import { PlugPortClient } from '@plugport/sdk';

const client = await PlugPortClient.connect(
  'http://localhost:8080'
);
const db = client.db('myapp');
const users = db.collection('users');
await users.insertOne({ name: 'Alice' });`}</code>
                        </pre>
                    </div>
                </div>
            </div>
        </section>
    );
}

export default function Home(): JSX.Element {
    const { siteConfig } = useDocusaurusContext();
    return (
        <Layout title="Home" description={siteConfig.tagline}>
            <HomepageHeader />
            <main>
                <HomepageFeatures />
                <QuickExample />
            </main>
        </Layout>
    );
}
