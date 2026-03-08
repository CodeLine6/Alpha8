import './globals.css';
import Sidebar from '@/components/Sidebar';

export const metadata = {
    title: 'Quant8 — Trading Dashboard',
    description: 'Real-time algorithmic trading dashboard for Quant8',
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link
                    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body>
                <Sidebar />
                <main
                    style={{
                        marginLeft: 'var(--sidebar-width)',
                        padding: 'clamp(1.5rem, 3vw, 3rem)',
                    }}
                    className="min-h-screen"
                >
                    {children}
                </main>
            </body>
        </html>
    );
}
