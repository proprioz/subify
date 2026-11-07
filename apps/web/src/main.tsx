import { setupIonicReact } from '@ionic/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './theme/palette';

import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '@ionic/react/css/padding.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';
import '@ionic/react/css/palettes/dark.class.css';
import './theme/theme.css';

// No swipe from the screen's edge to go back, in iOS mode: the back button alone does it.
setupIonicReact({ swipeBackEnabled: false });
// Follows the device until the saved theme is read from the database.
applyTheme('system');

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The page has no #root element.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
