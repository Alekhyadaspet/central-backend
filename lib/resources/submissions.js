// Copyright 2017 ODK Central Developers
// See the NOTICE file at the top-level directory of this distribution and at
// https://github.com/opendatakit/central-backend/blob/master/NOTICE.
// This file is part of ODK Central. It is subject to the license terms in
// the LICENSE file found in the top-level directory of this distribution and at
// https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
// including this file, may be copied, modified, propagated, or distributed
// except according to the terms contained in the LICENSE file.

const { createReadStream } = require('fs');
const { always, map } = require('ramda');
const sanitize = require('sanitize-filename');
const { createdMessage } = require('../outbound/openrosa');
const { getOrNotFound, resolve, getOrReject, rejectIf, reject, ignoringResult } = require('../util/promise');
const { QueryOptions } = require('../util/db');
const { success, xml } = require('../util/http');
const Option = require('../util/option');
const Problem = require('../util/problem');
const { streamBriefcaseCsvs } = require('../data/briefcase');
const { streamAttachments } = require('../data/attachments');
const { streamClientAudits } = require('../data/client-audits');
const { zipStreamFromParts } = require('../util/zip');

// multipart things:
const multer = require('multer');
const tmpdir = require('tmp').dirSync();
const multipart = multer({ dest: tmpdir.name });

// formbody things:
const bodyParser = require('body-parser');
const formParser = bodyParser.urlencoded({ extended: false });

module.exports = (service, endpoint) => {

  ////////////////////////////////////////////////////////////////////////////////
  // SUBMISSIONS (OPENROSA)

  // Nonstandard REST; OpenRosa-specific API.
  // This bit of silliness is to address the fact that the OpenRosa standards
  // specification requires the presence of a HEAD /submission endpoint, but
  // does not specify the presence of GET /submission. in order to fulfill that
  // spec without violating the HTTP spec, we have to populate GET /submission
  // with something silly. Unfortunately, because the OpenRosa spec also requires
  // the HEAD request to return with a 204 response code, which indicates that
  // there is no body content, and the HTTP spec requires that HEAD should
  // return exactly what GET would, just without a response body, the only thing
  // we can possibly respond with in either case is no body and a 204 code.
  service.get('/projects/:projectId/submission', endpoint(({ Project }, { params }, request, response) =>
    Project.getById(params.projectId)
      .then(getOrNotFound)
      .then(() => { response.status(204); })));

  // Nonstandard REST; OpenRosa-specific API.
  // TODO: we currently select the project twice over the course of this query;
  //       not the most performant idea..
  service.post('/projects/:projectId/submission', multipart.any(), endpoint.openRosa(({ Audit, Project, Submission, SubmissionAttachment, SubmissionPartial }, { params, files, auth, query }) =>
    Promise.all([
      // first, get the project. while we wait, process the form xml.
      Project.getById(params.projectId).then(getOrNotFound),
      resolve(Option.of(files).map((xs) => xs.find((file) => file.fieldname === 'xml_submission_file')))
        .then(getOrReject(Problem.user.missingMultipartField({ field: 'xml_submission_file' })))
        .then((file) => SubmissionPartial.fromXml(createReadStream(file.path)))
    ])
      // now we have the information we need to get the correct form; do so
      // and make sure we can actually submit to it.
      .then(([ project, partial ]) => project.getFormByXmlFormId(partial.xmlFormId)
        .then(getOrNotFound) // TODO: detail why
        .then((form) => auth.canOrReject('submission.create', form))
        .then(rejectIf(
          (form) => !form.acceptsSubmissions(),
          Problem.user.notAcceptingSubmissions
        ))
        .then((form) => Submission.getById(form.id, partial.instanceId, QueryOptions.extended)
          // we branch based on whether a submission already existed; in either case, we exit this
          // branching promise path with a Promise[Submission] that is complete (eg with an id).
          .then((maybeExtant) => maybeExtant
            // if a submission already exists, first verify that the posted xml still matches
            // (if it does not, reject). then, attach any new posted files.
            .map((extant) => extant.getCurrentVersion()
              .then(getOrNotFound) // TODO: sort of a goofy bailout case.
              .then((extantVersion) => ((Buffer.compare(Buffer.from(extantVersion.xml), Buffer.from(partial.xml)) !== 0)
                ? reject(Problem.user.xmlConflict())
                : extantVersion.upsertAttachments(files))))
            // otherwise, this is the first POST for this submission. create the
            // submission and the expected attachments:
            .orElseGet(() => partial.createAll(form, auth.actor(), query.deviceID)
              .then(ignoringResult(({ submission, submissionDef }) =>
                submissionDef.generateExpectedAttachments(form.def, files)
                  .then((attachments) => Promise.all([
                    SubmissionAttachment.createAll(attachments),
                    Audit.logAll(attachments
                      .filter((a) => a.blobId != null)
                      .map((attachment) => Audit.of(auth.actor(), 'submission.attachment.update', form, {
                        instanceId: submission.instanceId,
                        submissionDefId: submissionDef.id,
                        name: attachment.name,
                        newBlobId: attachment.blobId
                      })))
                  ]))))))
          // now we have a definite submission; we just need to do audit logging.
          .then((submission) => Audit.log(auth.actor(), 'submission.create', form, { submissionId: submission.id, instanceId: submission.instanceId }))
          // TODO: perhaps actually decide between "full" and "partial"; aggregate does this.
          .then(always(createdMessage({ message: 'full submission upload was successful!' })))))));


  ////////////////////////////////////////////////////////////////////////////////
  // SUBMISSIONS (STANDARD REST)

  // The remaining endpoints follow a more-standard REST subresource route pattern.
  // This first one performs the operation as the above.
  service.post('/projects/:projectId/forms/:formId/submissions', endpoint(({ Audit, Form, SubmissionAttachment, SubmissionPartial }, { params, body, auth }) =>
    Promise.all([
      Form.getByProjectAndXmlFormId(params.projectId, params.formId)
        .then(getOrNotFound)
        .then((form) => auth.canOrReject('submission.create', form)),
      SubmissionPartial.fromXml(body)
    ])
      .then(([ form, partial ]) => { // this syntax sucks but.. the alternatives do too.
        if (partial.xmlFormId !== params.formId)
          return reject(Problem.user.unexpectedValue({ field: 'form id', value: partial.xmlFormId, reason: 'did not match the form ID in the URL' }));
        if (!form.acceptsSubmissions())
          return reject(Problem.user.notAcceptingSubmissions());

        return partial.createAll(form, auth.actor())
          .then(({ submission, submissionDef }) => Promise.all([
            submissionDef.generateExpectedAttachments(form.def)
              .then((attachments) => SubmissionAttachment.createAll(attachments)),
            Audit.log(auth.actor(), 'submission.create', form, { submissionId: submission.id, instanceId: submission.instanceId })
          ])
            .then(always(submission)));
      })));

  ////////////////////////////////////////
  // CSVZIP EXPORT

  const csvzip = ({ ClientAudit, Key, Form, SubmissionAttachment, SubmissionDef },
    auth, projectId, xmlFormId, passphraseData, response) =>
    Form.getByProjectAndXmlFormId(projectId, xmlFormId)
      .then(getOrNotFound)
      .then((form) => auth.canOrReject('submission.read', form))
      .then((form) => Promise.all([
        SubmissionDef.streamForExport(form.id, Object.keys(passphraseData)),
        SubmissionAttachment.streamForExport(form.id, Object.keys(passphraseData)), // TODO: repetitive
        ClientAudit.streamForExport(form.id),
        Key.getDecryptor(map(decodeURIComponent, passphraseData)) // will do nothing if {}
      ]).then(([ rows, attachments, clientAudits, decryptor ]) => {
        const filename = sanitize(form.xmlFormId);
        response.append('Content-Disposition', `attachment; filename="${filename}.zip"`);
        response.append('Content-Type', 'application/zip');
        return streamBriefcaseCsvs(rows, form, decryptor).then((csvStream) =>
          zipStreamFromParts(csvStream,
            streamAttachments(attachments, decryptor),
            streamClientAudits(clientAudits, form)));
      }));

  service.get('/projects/:projectId/forms/:formId/submissions.csv.zip', endpoint((container, { params, auth, query }, _, response) =>
    csvzip(container, auth, params.projectId, params.formId, query, response)));

  service.post('/projects/:projectId/forms/:formId/submissions.csv.zip', formParser, endpoint((container, { params, auth, body }, _, response) =>
    csvzip(container, auth, params.projectId, params.formId, body, response)));

  // CSVZIP EXPORT
  ////////////////////////////////////////

  // TODO: paging.
  service.get('/projects/:projectId/forms/:formId/submissions', endpoint(({ Form, Submission }, { params, auth, queryOptions }) =>
    Form.getByProjectAndXmlFormId(params.projectId, params.formId)
      .then(getOrNotFound)
      .then((form) => auth.canOrReject('submission.list', form))
      .then((form) => Submission.getAllByFormId(form.id, queryOptions))));

  service.get('/projects/:projectId/forms/:formId/submissions/keys',
    endpoint(({ Key, Form }, { params, auth }) =>
      Form.getByProjectAndXmlFormId(params.projectId, params.formId)
        .then(getOrNotFound)
        .then((form) => auth.canOrReject('submission.read', form))
        .then((form) => Key.getActiveByFormId(form.id))));

  service.get('/projects/:projectId/forms/:formId/submissions/:instanceId.xml', endpoint(({ Form, SubmissionDef }, { params, auth }) =>
    Form.getByProjectAndXmlFormId(params.projectId, params.formId)
      .then(getOrNotFound)
      .then((form) => auth.canOrReject('submission.read', form))
      .then((form) => SubmissionDef.getCurrentByIds(form.projectId, form.xmlFormId, params.instanceId))
      .then(getOrNotFound)
      .then((def) => xml(def.xml))));

  service.get('/projects/:projectId/forms/:formId/submissions/:instanceId', endpoint(({ Form, Submission }, { params, auth, queryOptions }) =>
    Form.getByProjectAndXmlFormId(params.projectId, params.formId)
      .then(getOrNotFound)
      .then((form) => auth.canOrReject('submission.read', form))
      .then((form) => Submission.getById(form.id, params.instanceId, queryOptions))
      .then(getOrNotFound)));


  ////////////////////////////////////////////////////////////////////////////////
  // SUBMISSION ATTACHMENTS
  // TODO: a lot of layers to select through one at a time. eventually make more efficient.

  service.get(
    '/projects/:projectId/forms/:formId/submissions/:instanceId/attachments',
    endpoint(({ Form, SubmissionDef }, { params, auth }) =>
      Form.getByProjectAndXmlFormId(params.projectId, params.formId)
        .then(getOrNotFound)
        .then((form) => auth.canOrReject('submission.read', form))
        .then((form) => SubmissionDef.getCurrentByIds(form.projectId, form.xmlFormId, params.instanceId))
        .then(getOrNotFound)
        .then((def) => def.getAttachmentMetadata()))
  );

  service.get(
    '/projects/:projectId/forms/:formId/submissions/:instanceId/attachments/:name',
    endpoint(({ Blob, Form, SubmissionAttachment, SubmissionDef }, { params, auth }, _, response) =>
      Form.getByProjectAndXmlFormId(params.projectId, params.formId)
        .then(getOrNotFound)
        .then((form) => auth.canOrReject('submission.read', form))
        .then((form) => SubmissionDef.getCurrentByIds(form.projectId, form.xmlFormId, params.instanceId))
        .then(getOrNotFound)
        .then((def) => SubmissionAttachment.getBySubmissionDefIdAndName(def.id, params.name))
        .then(getOrNotFound)
        .then((attachment) => Blob.getById(attachment.blobId)
          .then(getOrNotFound)
          .then((blob) => {
            response.set('Content-Type', blob.contentType);
            response.set('Content-Disposition', `attachment; filename="${attachment.name}"`);
            return blob.content;
          })))
  );

  // TODO: wow audit-logging this is expensive.
  service.post(
    '/projects/:projectId/forms/:formId/submissions/:instanceId/attachments/:name',
    endpoint(({ Audit, Blob, Form, SubmissionAttachment, SubmissionDef }, { params, headers, auth }, request) =>
      Promise.all([
        Form.getByProjectAndXmlFormId(params.projectId, params.formId)
          .then(getOrNotFound)
          .then((form) => auth.canOrReject('submission.update', form))
          .then((form) => SubmissionDef.getCurrentByIds(form.projectId, form.xmlFormId, params.instanceId)
            .then(getOrNotFound)
            .then((def) => SubmissionAttachment.getBySubmissionDefIdAndName(def.id, params.name) // just for audit logging
              .then(getOrNotFound)
              .then((oldAttachment) => [ form, def, oldAttachment ]))),
        Blob.fromStream(request, headers['content-type'])
          .then((blob) => blob.ensure())
      ])
        .then(([ [ form, def, oldAttachment ], blob ]) => Promise.all([
          def.attach(params.name, blob),
          Audit.log(auth.actor(), 'submission.attachment.update', form, {
            instanceId: params.instanceId,
            submissionDefId: def.id,
            name: params.name,
            oldBlobId: oldAttachment.blobId,
            newBlobId: blob.id
          })
        ]))
        .then(([ wasSuccessful ]) => (wasSuccessful
          ? success()
          // should only be a Resolve[False] if everything worked but there wasn't a row to update.
          : reject(Problem.user.notFound()))))
  );

  service.delete(
    '/projects/:projectId/forms/:formId/submissions/:instanceId/attachments/:name',
    endpoint(({ Audit, Form, SubmissionAttachment, SubmissionDef }, { params, auth }) =>
      Form.getByProjectAndXmlFormId(params.projectId, params.formId)
        .then(getOrNotFound)
        .then((form) => auth.canOrReject('submission.update', form))
        .then((form) => SubmissionDef.getCurrentByIds(form.projectId, form.xmlFormId, params.instanceId)
          .then(getOrNotFound)
          .then((def) => SubmissionAttachment.getBySubmissionDefIdAndName(def.id, params.name)
            .then(getOrNotFound)
            .then((attachment) => Promise.all([
              attachment.clear(),
              Audit.log(auth.actor(), 'submission.attachment.update', form, {
                instanceId: params.instanceId,
                submissionDefId: def.id,
                name: attachment.name,
                oldBlobId: attachment.blobId
              })
            ]))))
        .then(success))
  );
};

