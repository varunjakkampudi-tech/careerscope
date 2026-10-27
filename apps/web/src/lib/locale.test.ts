import assert from 'node:assert/strict';
import test from 'node:test';
import {
  interfaceMessage,
  interfaceLocales,
  isInterfaceLocale,
  localizedApiErrorMessage,
  localizedText,
  localizedValue,
} from './locale.js';

test('interface locale validation accepts only the three approved languages', () => {
  assert.deepEqual(interfaceLocales, ['en', 'te', 'hi']);
  for (const locale of interfaceLocales) assert.equal(isInterfaceLocale(locale), true);
  for (const value of [undefined, null, '', 'fr', 'EN', 1, {}])
    assert.equal(isInterfaceLocale(value), false);
});

test('shared navigation and reminder messages are present for each supported language', () => {
  for (const locale of interfaceLocales) {
    assert.ok(localizedText(locale, 'jobs').length > 0);
    assert.ok(localizedText(locale, 'notifications').length > 0);
    assert.ok(localizedText(locale, 'reminderPrivacy').length > 0);
    const unread = interfaceMessage(locale, 'unreadNotifications');
    assert.equal(typeof unread, 'function');
    assert.ok(localizedText(locale, 'unreadNotifications', 2).includes('2'));
  }
  assert.notEqual(localizedText('en', 'jobs'), localizedText('te', 'jobs'));
  assert.notEqual(localizedText('en', 'jobs'), localizedText('hi', 'jobs'));
});

test('interview notification preference labels and safety notes are localized for each language', () => {
  const keys = [
    'notificationPreferencesHeading',
    'notificationPreferencesDescription',
    'notificationPreferencesLoading',
    'notificationPreferencesLoadError',
    'notificationPreferencesUnconfirmed',
    'notificationPreferencesConnection',
    'notificationReminderToggle',
    'notificationReminderNote',
    'notificationPreferenceSaving',
    'notificationPreferenceSaved',
    'notificationPreferenceReloaded',
    'retry',
  ] as const;

  for (const key of keys) {
    const translated = interfaceLocales.map((locale) => localizedText(locale, key));
    assert.ok(
      translated.every((message) => message.trim().length > 0),
      key,
    );
    assert.equal(new Set(translated).size, interfaceLocales.length, key);
  }
});

test('account-security controls have distinct translations and preserve interpolation values', () => {
  const keys = [
    'accountSecurity',
    'changeSignInEmail',
    'activeSessions',
    'optionalProductUpdates',
    'sessionSignOutAllConfirm',
    'emailChangeCodesSent',
  ] as const;
  for (const key of keys) {
    const values = interfaceLocales.map((locale) => localizedText(locale, key));
    assert.ok(
      values.every((value) => value.trim().length > 0),
      key,
    );
    assert.equal(new Set(values).size, interfaceLocales.length, key);
  }
  assert.equal(
    localizedValue('en', 'signOutDeviceConfirm', 'Laptop'),
    'Sign out Laptop? That device will need to sign in again.',
  );
  assert.equal(localizedValue('en', 'signOutDeviceLabel', 'Test device'), 'Sign out Test device');
  assert.equal(
    localizedValue('te', 'signOutDeviceConfirm', 'ల్యాప్‌టాప్'),
    'ల్యాప్‌టాప్ నుంచి సైన్ అవుట్ చేయాలా? ఆ పరికరం మళ్లీ సైన్ ఇన్ చేయాలి.',
  );
  assert.equal(localizedValue('hi', 'emailVerifiedOn', '22 Oct'), '22 Oct को ईमेल सत्यापित हुआ।');
  assert.equal(localizedValue('te', 'versionInParentheses', 'test-1'), ' (వెర్షన్ test-1)');
});

test('account-security API error categories are localized with a generic unknown-status fallback', () => {
  for (const locale of interfaceLocales) {
    assert.ok(localizedApiErrorMessage(locale, 429).length > 0);
    assert.ok(localizedApiErrorMessage(locale, 503).length > 0);
    assert.ok(localizedApiErrorMessage(locale, 599).length > 0);
  }
  assert.notEqual(localizedApiErrorMessage('te', 503), localizedApiErrorMessage('hi', 503));
  assert.equal(localizedApiErrorMessage('en', 599), localizedText('en', 'apiErrorDefault'));
});

test('job-search controls, empty states, and feedback labels have locale-specific copy', () => {
  const keys = [
    'searchHistoryHeading',
    'findYourNextRole',
    'searchSourcesLegend',
    'discoveryMode',
    'roleOrTechnology',
    'savedTargetRoles',
    'noSearchSelected',
    'searchReturnedNoResults',
    'jobDescriptionUnavailable',
    'reportPostingIssue',
    'feedbackSuspicious',
    'feedbackRecorded',
  ] as const;
  for (const key of keys) {
    const values = interfaceLocales.map((locale) => localizedText(locale, key));
    assert.ok(
      values.every((value) => value.trim().length > 0),
      key,
    );
    assert.equal(new Set(values).size, interfaceLocales.length, key);
  }
});

test('sign-in and one-time-code messages have parity and distinct translations across languages', () => {
  const keys = [
    'noticeRateLimited',
    'testModeBrandVersion',
    'secureEmailSignIn',
    'signInUnavailable',
    'couldNotRequestCode',
    'couldNotVerifyCode',
    'selectTestAccount',
    'chooseRoleToEnter',
    'sessionExpiredUnsaved',
    'roleAdmin',
    'roleCandidate',
    'adminWorkspaceDescription',
    'candidateWorkspaceDescription',
    'createCareerScopeAccount',
    'signInToCareerScope',
    'verifyEmailSignUp',
    'verifyEmailSignIn',
    'checkInboxForCode',
    'emailAddress',
    'sixDigitVerificationCode',
    'enterCodeHelp',
    'verifying',
    'verifyAndCreateAccount',
    'verifyAndSignIn',
    'sending',
    'resendCodeIn',
    'resendCode',
    'useDifferentEmail',
    'dateOfBirth',
    'ageScreenHelp',
    'legalNotices',
    'acceptTermsPrefix',
    'termsOfServiceWithVersion',
    'acknowledgePrivacyPrefix',
    'privacyNoticeWithVersion',
    'marketingOptInLabel',
    'sendVerificationCode',
    'signInExistingAccount',
    'createAnAccount',
    'noSignInMethod',
  ] as const;
  for (const key of keys) {
    const values = interfaceLocales.map((locale) => localizedText(locale, key));
    assert.ok(
      values.every((value) => value.trim().length > 0),
      key,
    );
    assert.equal(new Set(values).size, interfaceLocales.length, key);
  }
  assert.equal(localizedValue('en', 'resendCodeIn', 30), 'Resend code in 30s');
  assert.equal(localizedValue('te', 'resendCodeIn', 30), '30 సెకన్లలో కోడ్‌ను మళ్లీ పంపండి');
  assert.equal(localizedValue('hi', 'resendCodeIn', 30), '30 सेकंड में कोड फिर भेजें');
  assert.equal(
    localizedValue('en', 'termsOfServiceWithVersion', 'v1.0'),
    'Terms of Service (v1.0)',
  );
});
