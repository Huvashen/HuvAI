import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app.component';

bootstrapApplication(AppComponent).catch(() => {
  document.body.textContent = 'JARVIS could not open. Rebuild the desktop app and try again.';
});
