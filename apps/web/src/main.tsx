import { ConfigProvider, App as AntApp } from 'antd';
import faIR from 'antd/locale/fa_IR';
import 'antd/dist/reset.css';
import '@fontsource-variable/vazirmatn';
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import { theme } from './theme';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ConfigProvider direction="rtl" locale={faIR} theme={theme}>
      <AntApp>
        <BrowserRouter>
          <AuthProvider><App /></AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
